"""M5: the run sequencer. Strictly glue — validate, sequence, emit events.
The Tier-1 survival rule lives here: the deterministic verdict and report
publish even when the investigator (or anything agent-side) dies."""
import datetime
import os
import time
import traceback

from atlas.referee.comparator import evaluate
from atlas.referee.report import build_report
from atlas.runner import artifacts, paired_runner, revisions, sandbox_mgr
from atlas.runner.images import harness_image

# atlas_v1/ locally; /root inside the controller container (demo/ rides along).
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REQUIRED = ("run", "mode", "repo", "base_sha", "gpu", "image", "evals")

COOLDOWN_S = 600  # parked-sandbox lease; the 1800s sandbox timeout hard-caps


# --- warm sandbox pool ------------------------------------------------------
# Registry: modal.Dict "atlas-sandboxes", sandbox_id -> {repo, gpu, state,
# deadline, attached, created_at}. Modal touchpoints sit behind module hooks
# so tests monkeypatch them; pool trouble NEVER blocks or breaks a run.

def _default_pool_dict():
    import modal  # lazy: only reachable on Modal / with credentials
    from atlas.contracts.names import DICT_SANDBOXES
    return modal.Dict.from_name(DICT_SANDBOXES, create_if_missing=True)


def _default_sandbox_from_id(sandbox_id: str):
    import modal  # lazy, same reason
    return modal.Sandbox.from_id(sandbox_id)


_pool_dict = _default_pool_dict
_sandbox_from_id = _default_sandbox_from_id


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec="seconds")


def sweep_pool(entries: dict, now: float) -> list[str]:
    """Pure decision: ids of parked sandboxes past their deadline."""
    return [sid for sid, e in sorted(entries.items())
            if isinstance(e, dict) and e.get("state") == "cooldown"
            and (e.get("deadline") or 0) <= now]


def reuse_candidate(entries: dict, repo: str, gpu: str, now: float):
    """Pure decision: a parked, unexpired sandbox matching repo+gpu."""
    for sid, e in sorted(entries.items()):
        if (isinstance(e, dict) and e.get("state") == "cooldown"
                and (e.get("deadline") or 0) > now
                and e.get("repo") == repo and e.get("gpu") == gpu):
            return sid
    return None


def _pool_set(pool, sandbox_id: str, **fields) -> None:
    """Merge fields into a registry entry; failures are swallowed."""
    try:
        e = dict(pool.get(sandbox_id) or {})
        e.update(fields)
        e.setdefault("created_at", _now_iso())
        pool[sandbox_id] = e
    except Exception:
        pass


def _alive(sb) -> bool:
    try:
        return sb.poll() is None  # None = still running (Modal semantics)
    except Exception:
        return False


def acquire_sandbox(spec: dict, emit):
    """Sweep expired parked sandboxes, reuse a live repo+gpu match (emit
    sandbox_reused), else create fresh (emit sandbox_up, as before)."""
    run_id = spec["run"]
    pool = None
    try:
        pool = _pool_dict()
        now = time.time()
        entries = {k: v for k, v in pool.items()}
        for sid in sweep_pool(entries, now):
            try:
                _sandbox_from_id(sid).terminate()
            except Exception:
                pass  # already gone; nothing to leak
            _pool_set(pool, sid, state="terminated")
        sid = reuse_candidate(entries, spec["repo"], spec["gpu"], now)
        if sid is not None:
            sb = None
            try:
                sb = _sandbox_from_id(sid)
            except Exception:
                pass
            if sb is not None and _alive(sb):
                _pool_set(pool, sid, state="running", deadline=None,
                          attached={"run": run_id})
                emit("system", "sandbox_reused",
                     {"sandbox": sid, "gpu": spec["gpu"]})
                return sb
            _pool_set(pool, sid, state="terminated")  # stale entry
    except Exception:
        pool = None  # unreachable registry: run without the pool
    sb = sandbox_mgr.create_sandbox(run_id, spec["gpu"], harness_image(ROOT))
    if pool is not None:
        _pool_set(pool, sb.object_id, repo=spec["repo"], gpu=spec["gpu"],
                  state="running", deadline=None, attached={"run": run_id})
    emit("system", "sandbox_up", {"sandbox": sb.object_id,
                                  "gpu": sandbox_mgr.ready_check(sb)})
    return sb


def release_sandbox(sb, spec: dict, completed: bool, emit) -> None:
    """Normal completion parks the sandbox warm (cooldown lease); failure —
    or a failed park — terminates. Never leaks a GPU."""
    if sb is None:
        return
    sid = sb.object_id
    if completed:
        try:
            pool = _pool_dict()
            deadline = int(time.time()) + COOLDOWN_S
            e = dict(pool.get(sid) or {})
            e.update({"repo": spec["repo"], "gpu": spec["gpu"],
                      "state": "cooldown", "deadline": deadline,
                      "attached": {"run": spec["run"]}})
            e.setdefault("created_at", _now_iso())
            pool[sid] = e
            emit("system", "sandbox_parked",
                 {"sandbox": sid, "cooldown_s": COOLDOWN_S,
                  "deadline": deadline})
            return
        except Exception:
            pass  # can't park -> fall through to terminate
    sandbox_mgr.terminate(sb)
    try:
        _pool_set(_pool_dict(), sid, state="terminated")
    except Exception:
        pass
    emit("system", "terminated", {"sandbox": sid})


def validate_spec(spec: dict) -> None:
    missing = [k for k in REQUIRED if not spec.get(k)]
    if missing:
        raise ValueError(f"spec missing {missing}")
    if spec["mode"] not in ("compare", "check"):
        raise ValueError(f"bad mode: {spec['mode']}")
    if spec["mode"] == "compare" and not spec.get("head_sha"):
        raise ValueError("compare mode needs head_sha")
    for ev in spec["evals"]:
        if not ev.get("name") or not ev.get("cmd"):
            raise ValueError(f"bad eval: {ev}")


def needs_investigation(verdict: dict) -> bool:
    return (verdict["verdict"] == "regression"
            or any(c.get("flagged") for c in verdict.get("checks", [])))


def plan_evals(spec: dict, emit) -> list[dict]:
    """Agent run plan; ANY failure falls back to the full declared suite."""
    try:
        from atlas.investigator.loop import plan
        p = plan(spec, spec.get("diff", ""))
        names = set(p.get("evals") or [])
        # scoped (PR-proposed) evals were requested explicitly; the planner
        # may narrow the suite around them but never drop them
        chosen = [ev for ev in spec["evals"]
                  if ev["name"] in names or ev.get("scoped")] or spec["evals"]
        emit("agent", "plan", {"evals": [e["name"] for e in chosen],
                               "extra_metrics": p.get("extra_metrics", []),
                               "reasoning": p.get("reasoning", "")})
        return chosen
    except Exception as e:
        emit("system", "plan_fallback",
             {"reason": f"{type(e).__name__}: {e}",
              "evals": [ev["name"] for ev in spec["evals"]]})
        return spec["evals"]


def failed_investigation(run_id: str, why: str) -> dict:
    return {"schema": "1", "run": run_id, "status": "failed",
            "observations": [], "hypotheses": [], "proposals": [],
            "diagnosis": {"text": f"investigator unavailable ({why}); "
                          "diagnosis inconclusive", "confidence": "low"}}


def probe_overrides(params: dict) -> dict:
    """Probe params -> bench param overrides (see investigator/tools.py)."""
    ov = {k: params[k] for k in ("tokens", "repeats", "batch") if k in params}
    if params.get("override"):  # declared override pair, e.g. batch
        ov[params["override"]] = params["value"]
    return ov


def investigate_or_survive(spec, verdict, sb, volume, emit) -> dict:
    """The Tier-1 survival boundary: ANY investigator exception -> status
    failed + inconclusive diagnosis; the run still completes and reports.
    Wiring per investigator/tools.py: probe_callback(kind, params),
    approval_lookup(key) over the approvals Dict."""
    state = {"n": 0}

    def probe(kind, params):
        state["n"] += 1
        ev = next((e for e in spec["evals"] if e["name"] == params.get("eval")),
                  spec["evals"][0])
        return paired_runner.run_blocks(
            sb, spec, ev, probe_overrides(params),
            out_subdir=f"probes/p{state['n']}",
            profile=(kind == "profile_pair"), volume=volume,
            on_block=lambda r: emit("system", "bench_block_done", headline(r)))

    try:
        import modal
        from atlas.contracts.names import DICT_APPROVALS
        from atlas.investigator.loop import investigate
        approvals = modal.Dict.from_name(DICT_APPROVALS, create_if_missing=True)
        return investigate(spec["run"], artifacts.runs_root(), spec, verdict,
                           probe, approvals.get)
    except Exception as e:
        return failed_investigation(spec["run"], f"{type(e).__name__}: {e}")


def headline(r: dict) -> dict:
    s = r.get("summary", {})
    return {"revision": r["label"], "block": r["block"], "eval": r["eval"],
            "status": r["status"],
            "tokens_per_s": round(s.get("tokens_per_s", 0), 1),
            "latency_ms_p95": round(s.get("latency_ms_p95", 0), 1),
            "peak_vram_mb": round(s.get("peak_vram_mb", 0), 1)}


def run(spec: dict, volume=None) -> dict:
    validate_spec(spec)
    run_id = spec["run"]
    d = artifacts.run_dir(run_id)

    def emit(tier, kind, detail):
        artifacts.event(run_id, tier, kind, detail, volume=volume)

    artifacts.write_json(f"{d}/spec.json", spec, volume)
    emit("system", "submitted", {"mode": spec["mode"], "repo": spec["repo"],
                                 "base": spec["base_sha"][:8],
                                 "head": spec.get("head_sha", "")[:8],
                                 "gpu": spec["gpu"]})
    evals = plan_evals(spec, emit)
    sb, verdict, investigation = None, None, None
    completed = False
    try:
        sb = acquire_sandbox(spec, emit)

        # fresh clone dirs per run: a reused sandbox never shares trees
        work = f"/work/{run_id}"
        shas = {"base": revisions.materialize(sb, spec["repo"],
                                              spec["base_sha"], f"{work}/base")}
        if spec["mode"] == "compare":
            shas["head"] = revisions.materialize(sb, spec["repo"],
                                                 spec["head_sha"],
                                                 f"{work}/head")
            if spec.get("patch"):  # demo path: candidate = head + patch
                revisions.apply_patch(sb, f"{work}/head",
                                      f"/harness/patches/{spec['patch']}")
                shas["patch"] = spec["patch"]
        emit("system", "revisions_ready", shas)

        pre = paired_runner.preflight(sb, spec, volume)
        ok = all(b["status"] == "completed" for b in pre)
        emit("system", "preflight_ok" if ok else "preflight_failed",
             {b["label"]: b["status"] for b in pre})

        blocks = pre if not ok else []  # failed preflight = the evidence
        for ev in (evals if ok else []):
            blocks += paired_runner.run_blocks(
                sb, spec, ev, volume=volume,
                on_block=lambda r: emit("system", "bench_block_done", headline(r)))

        verdict = evaluate(spec, blocks)
        artifacts.write_json(f"{d}/verdict.json", verdict, volume)
        emit("policy", "verdict",
             {"verdict": verdict["verdict"],
              "violations": [f"{c['metric']} {c['eval']} "
                             f"{c.get('delta_pct', c.get('cand'))}"
                             for c in verdict["checks"] if c["violated"]]})

        if needs_investigation(verdict):
            emit("agent", "investigation_started", {"trigger": verdict["verdict"]})
            investigation = investigate_or_survive(spec, verdict, sb, volume, emit)
            artifacts.write_json(f"{d}/investigation.json", investigation, volume)
            emit("agent", "investigation_done", {"status": investigation["status"]})
        completed = True  # normal completion -> the sandbox is parkable
    except Exception as e:  # infra failure: still publish an honest verdict
        emit("system", "error", {"error": f"{type(e).__name__}: {e}",
                                 "traceback": traceback.format_exc()[-2000:]})
        if verdict is None:
            verdict = {"schema": "1", "run": run_id, "verdict": "invalid",
                       "checks": [], "correctness": {"result": "n/a"},
                       "invalid_reason": f"controller error: {e}"}
            artifacts.write_json(f"{d}/verdict.json", verdict, volume)
            emit("policy", "verdict", {"verdict": "invalid"})
    finally:
        release_sandbox(sb, spec, completed, emit)

    report = build_report(verdict, investigation)
    artifacts.write_json(f"{d}/report.json", report, volume)
    emit("system", "report_ready", {"verdict": verdict["verdict"]})
    return report
