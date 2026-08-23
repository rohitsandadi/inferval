"""Session-agent tools. Every tool emits its event(s) via append_event before
returning; every ceiling is enforced here, outside the model. Rejections are
returned to the model as text — a rejected call is a normal outcome.

Modal touchpoints (sandbox creation/registry, POST /api/runs) sit behind
injectable SessionContext fields with lazy imports, so tests never load Modal:
  sandbox_factory(ctx, kind, gpu) -> (sb, sandbox_id)
  sandbox_release(sb, sandbox_id) -> None          # registry -> cooldown
  eval_runner(ctx, eval_spec, overrides, out_subdir) -> list[BlockResult]
  post_run(payload) -> run_id                       # POST /api/runs
"""
import json
import os
import statistics
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from agents import function_tool

from atlas.contracts.evalspec import validate_eval, validate_scoped
from atlas.contracts.names import (APP_NAME, DICT_APPROVALS, DICT_SANDBOXES,
                                   VOLUME_CACHE, VOLUME_RUNS)
from atlas.referee.events import append_event

SANDBOX_TIMEOUT_S = 900
COOLDOWN_S = 600
EXEC_TIMEOUT_S = 300
EXEC_TAIL_BYTES = 4096
DEFAULT_API_URL = "https://atlas-verification--atlas-api.modal.run"

# Environment allowlist with the cost line rendered on the decision card.
ENV_COST = {"none": "$0", "cpu": "~$0.01/run",
            "T4": "$0.59/h", "A10G": "$1.10/h", "A100": "$2.78/h"}

# run_eval cost model (mirrors investigator/probes.py; copied, not imported —
# modules don't import each other).
BLOCK_OVERHEAD_S = 12.0
TOKENS_PER_S_EST = 300.0
EVAL_BLOCKS = 4  # paired abba


@dataclass
class SessionContext:
    chat_id: str
    runs_root: str
    repo: dict                       # repos.json entry (may be minimal)
    meta: dict                       # meta.json content
    approvals: str = "auto"
    approval_lookup: Callable[[str], str | None] | None = None
    approval_timeout_s: float = 600.0
    poll_interval_s: float = 2.0
    gpu_seconds_budget: float = 120.0
    volume: Any = None               # runs Volume; commit after each emit
    # injectable backings (None -> production defaults with lazy modal import)
    sandbox_factory: Callable | None = None
    sandbox_release: Callable | None = None
    eval_runner: Callable | None = None
    post_run: Callable | None = None
    # ledger — mutated as tools execute
    env_kind: str | None = None
    env_reason: str | None = None
    sandbox: Any = None
    sandbox_id: str | None = None
    sandbox_gpu: str | None = None
    gpu_seconds_used: float = 0.0
    evals_run: int = 0
    reviews_submitted: int = 0
    proposals: list[dict] = field(default_factory=list)

    @property
    def chat_dir(self) -> str:
        return os.path.join(self.runs_root, "chats", self.chat_id)

    def sandbox_line(self) -> str:
        if self.sandbox is None:
            return "none"
        return f"{self.sandbox_id} live ({self.sandbox_gpu or 'cpu'})"


def emit(ctx: SessionContext, tier: str, kind: str, detail: dict,
         refs: list[str] | None = None) -> dict:
    e = append_event(os.path.join(ctx.runs_root, "chats"), ctx.chat_id,
                     tier, kind, detail, refs=refs)
    if ctx.volume is not None:
        try:
            ctx.volume.commit()
        except Exception:
            pass  # a missed commit beats a dead turn
    return e


# --- plain, directly-testable tool bodies -----------------------------------

def set_status(ctx: SessionContext, text: str) -> str:
    emit(ctx, "agent", "thinking", {"text": text})
    return "status shown"


def decide_environment(ctx: SessionContext, kind: str, reason: str) -> str:
    if kind not in ENV_COST:
        return f"invalid kind {kind!r}; one of {list(ENV_COST)}"
    ctx.env_kind, ctx.env_reason = kind, reason
    emit(ctx, "agent", "env_decision",
         {"kind": kind, "reason": reason, "est_cost": ENV_COST[kind]})
    if kind == "none":
        return "environment set to none ($0); no sandbox will be created"
    return (f"environment set to {kind} ({ENV_COST[kind]}); "
            "create_sandbox will honor it")


def _default_sandbox_factory(ctx: SessionContext, kind: str, gpu: str | None):
    import modal  # lazy: only reachable in production / live smoke
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if gpu:
        from atlas.runner.images import harness_image  # sanctioned reuse
        image = harness_image(root)
    else:
        image = modal.Image.debian_slim(python_version="3.12").apt_install("git")
    app = modal.App.lookup(APP_NAME, create_if_missing=True)
    sb = modal.Sandbox.create(
        app=app, image=image, gpu=gpu,
        tags={"session": ctx.chat_id},
        volumes={"/cache": modal.Volume.from_name(VOLUME_CACHE, create_if_missing=True),
                 "/runs": modal.Volume.from_name(VOLUME_RUNS, create_if_missing=True)},
        timeout=SANDBOX_TIMEOUT_S)
    sid = sb.object_id
    d = modal.Dict.from_name(DICT_SANDBOXES, create_if_missing=True)
    d[sid] = {"repo": ctx.repo.get("name"), "gpu": gpu or "cpu",
              "state": "running", "deadline": time.time() + SANDBOX_TIMEOUT_S,
              "session": ctx.chat_id}
    return sb, sid


def _default_approval_lookup(key: str) -> str | None:
    import modal  # lazy
    return modal.Dict.from_name(DICT_APPROVALS, create_if_missing=True).get(key)


def _wait_approval(ctx: SessionContext, pid: str) -> str:
    lookup = ctx.approval_lookup or _default_approval_lookup
    key = f"{ctx.chat_id}:{pid}"
    deadline = time.monotonic() + ctx.approval_timeout_s
    while time.monotonic() < deadline:
        decision = lookup(key)
        if decision in ("approved", "denied"):
            return decision
        time.sleep(ctx.poll_interval_s)
    return "expired"


def create_sandbox(ctx: SessionContext) -> str:
    if ctx.env_kind is None:
        return "not created: call decide_environment first"
    if ctx.env_kind == "none":
        return "not created: the environment decision is 'none' (no sandbox needed)"
    if ctx.sandbox is not None:
        return (f"not created: sandbox {ctx.sandbox_id} is already live "
                "(max 1 per session); use exec on it")
    kind = ctx.env_kind
    gpu = None if kind == "cpu" else kind

    if gpu and ctx.approvals != "auto":
        pid = f"sb{len(ctx.proposals) + 1}"
        prop = {"id": pid, "kind": "sandbox", "gpu": gpu,
                "reason": ctx.env_reason or "", "est_cost": ENV_COST[kind],
                "status": "proposed"}
        ctx.proposals.append(prop)
        emit(ctx, "agent", "sandbox_proposed", dict(prop))
        decision = _wait_approval(ctx, pid)
        if decision != "approved":
            prop["status"] = decision  # denied | expired
            emit(ctx, "agent", "sandbox_" + decision, {"id": pid})
            return (f"sandbox not created ({decision}); continue with the "
                    "evidence you have or pick a cheaper environment")
        prop["status"] = "approved"

    factory = ctx.sandbox_factory or _default_sandbox_factory
    try:
        sb, sid = factory(ctx, kind, gpu)
    except Exception as e:
        return f"sandbox creation failed: {e}"
    ctx.sandbox, ctx.sandbox_id, ctx.sandbox_gpu = sb, sid, gpu
    emit(ctx, "system", "sandbox_created",
         {"sandbox_id": sid, "kind": kind, "gpu": gpu or "cpu",
          "est_cost": ENV_COST[kind], "timeout_s": SANDBOX_TIMEOUT_S})
    return f"sandbox {sid} live ({kind}); run commands with exec"


def exec_cmd(ctx: SessionContext, cmd: str) -> str:
    if ctx.sandbox is None:
        return "no live sandbox: decide_environment then create_sandbox first"
    rc, tail = -1, ""
    try:
        p = ctx.sandbox.exec("bash", "-c", cmd, timeout=EXEC_TIMEOUT_S)
        out = p.stdout.read()
        err = p.stderr.read()
        p.wait()
        rc = p.returncode
        combined = (out or "") + (("\n--- stderr ---\n" + err) if err else "")
        tail = combined[-EXEC_TAIL_BYTES:]
    except Exception as e:
        tail = f"exec transport failure: {e}"
    emit(ctx, "agent", "sandbox_exec",
         {"cmd": cmd[:500], "exit": rc, "tail": tail})
    return f"exit {rc}\n{tail}"


def _estimate_eval_seconds(cmd: str, overrides: dict | None) -> float:
    """Paired-run cost from the declared cmd's --tokens/--repeats (plus
    overrides), same basis as the probe cost model."""
    import shlex
    params = {"tokens": 128, "repeats": 5}
    toks = shlex.split(cmd or "")
    for i, t in enumerate(toks[:-1]):
        key = t.lstrip("-")
        if t.startswith("--") and key in params:
            try:
                params[key] = int(toks[i + 1])
            except ValueError:
                pass
    for k in params:
        if overrides and k in overrides:
            params[k] = overrides[k]
    est = EVAL_BLOCKS * (BLOCK_OVERHEAD_S
                         + params["repeats"] * params["tokens"] / TOKENS_PER_S_EST)
    return round(est, 1)


def _summarize_blocks(blocks: list[dict]) -> str:
    lines = []
    medians: dict[str, float] = {}
    for b in blocks:
        if b.get("status") != "completed":
            lines.append(f"{b.get('label')}: FAILED {str(b.get('error', ''))[:120]}")
            continue
        vals = []
        for m in ("tokens_per_s", "latency_ms_p95", "peak_vram_mb"):
            xs = b.get("samples", {}).get(m) or []
            if xs:
                med = statistics.median(xs)
                vals.append(f"{m}={med:.1f}")
                medians.setdefault(f"{b['label']}:{m}", med)
        lines.append(f"{b.get('label')} b{b.get('block')}: " + ", ".join(vals))
    b_tps, h_tps = medians.get("base:tokens_per_s"), medians.get("head:tokens_per_s")
    if b_tps and h_tps:
        lines.append(f"delta tokens_per_s: {(h_tps / b_tps - 1) * 100:+.1f}%")
    return "\n".join(lines)


def _default_eval_runner(ctx: SessionContext, eval_spec: dict,
                         overrides: dict | None, out_subdir: str) -> list[dict]:
    run_id = f"chats/{ctx.chat_id}"
    base, head = f"/work/{run_id}/base", f"/work/{run_id}/head"
    if ctx.sandbox is None:
        raise RuntimeError(f"run_eval needs a live sandbox with {base} and "
                           f"{head} prepared (use exec to clone/checkout first)")
    p = ctx.sandbox.exec("bash", "-c", f"test -d {base} && test -d {head}")
    p.wait()
    if p.returncode != 0:
        raise RuntimeError(f"work trees missing: check out the base revision "
                           f"at {base} and the head revision at {head} with "
                           "exec first (git worktree add), then retry")
    from atlas.runner.paired_runner import run_blocks  # sanctioned reuse
    run_spec = {"run": run_id, "mode": "compare"}
    return run_blocks(ctx.sandbox, run_spec, eval_spec, overrides=overrides,
                      out_subdir=out_subdir, volume=ctx.volume)


def run_eval(ctx: SessionContext, name: str, overrides: dict | None = None) -> str:
    suite = ctx.repo.get("evals", [])
    eval_spec = next((e for e in suite if e.get("name") == name), None)
    if eval_spec is None:
        return f"unknown eval {name!r}; declared suite: {[e['name'] for e in suite]}"
    allowed = {"tokens", "repeats", "batch"} | set(ctx.repo.get("overrides", []))
    bad = [k for k in (overrides or {}) if k not in allowed]
    if bad:
        return f"overrides {bad} not allowed; allowed keys: {sorted(allowed)}"
    est = _estimate_eval_seconds(eval_spec.get("cmd", ""), overrides)
    if ctx.gpu_seconds_used + est > ctx.gpu_seconds_budget:
        return (f"not run: GPU-seconds budget exhausted "
                f"({ctx.gpu_seconds_used:.0f}s used, "
                f"{ctx.gpu_seconds_budget:.0f}s ceiling, eval needs {est:.0f}s); "
                "finish with the evidence you have or submit_review")

    eid = f"x{ctx.evals_run + 1}"
    runner = ctx.eval_runner or _default_eval_runner
    try:
        blocks = runner(ctx, eval_spec, dict(overrides or {}),
                        os.path.join("experiments", eid))
    except Exception as e:
        return f"run_eval failed: {e}"

    ctx.gpu_seconds_used += est
    ctx.evals_run += 1
    exp_dir = os.path.join(ctx.chat_dir, "experiments", eid)
    os.makedirs(exp_dir, exist_ok=True)
    refs = []
    for i, b in enumerate(blocks):
        rel = os.path.join("experiments", eid, f"b{i}_{b.get('label', '?')}.json")
        with open(os.path.join(ctx.chat_dir, rel), "w") as f:
            json.dump(b, f)
        refs.append(rel)
    summary = _summarize_blocks(blocks)
    headline = summary.splitlines()[-1] if summary else "no blocks returned"
    emit(ctx, "agent", "test_result",
         {"eval": name, "experiment": eid, "gpu_seconds": est,
          "headline": headline}, refs=refs)
    return f"eval {name} done -> experiment {eid} ({est:.0f}s GPU debited)\n{summary}"


def _default_post_run(payload: dict) -> str:
    import httpx  # lazy — rides with the openai dep
    base_url = os.environ.get("ATLAS_API_URL", DEFAULT_API_URL)
    r = httpx.post(f"{base_url}/api/runs", json=payload, timeout=30.0)
    r.raise_for_status()
    return r.json()["run"]


def submit_review(ctx: SessionContext, base: str, head: str,
                  evals: list[str] | None = None,
                  include_draft: str | None = None) -> str:
    if ctx.reviews_submitted >= 1:
        return "not submitted: one formal review per turn (ceiling)"
    payload: dict[str, Any] = {"repo": ctx.repo.get("name"), "mode": "compare",
                               "base_sha": base, "head_sha": head,
                               "approvals": ctx.approvals}
    if evals:
        payload["selection"] = "pick"
        payload["evals"] = evals
    pr = (ctx.meta or {}).get("pr") or {}

    draft = None
    if include_draft:
        drafts_path = os.path.join(ctx.chat_dir, "drafts.json")
        try:
            with open(drafts_path) as f:
                drafts = json.load(f)
        except (FileNotFoundError, ValueError):
            drafts = []
        draft = next((d for d in drafts if d.get("id") == include_draft), None)
        if draft is None:
            return (f"unknown draft {include_draft!r}; known: "
                    f"{[d.get('id') for d in drafts]}")
        entry = {"name": draft["name"], "cmd": draft["cmd"],
                 "checks": draft["checks"]}
        try:  # re-check at the submission boundary; drafts.json is a file
            entry = validate_eval(entry)
            validate_scoped(entry, ctx.repo.get("evals", []))
        except ValueError as e:
            return f"draft {include_draft} no longer valid: {e}"
        if pr.get("number"):
            entry["origin"] = f"pr:{pr['number']}"
        payload["extra_evals"] = [entry]
    if pr.get("title"):
        payload["claim"] = pr["title"]
    if (ctx.meta or {}).get("branch"):
        payload["branch"] = ctx.meta["branch"]
    poster = ctx.post_run or _default_post_run
    try:
        run_id = poster(payload)
    except Exception as e:
        return f"review submission failed: {e}"
    ctx.reviews_submitted += 1
    if draft is not None:
        draft["status"] = "submitted"
        draft["run"] = run_id
        with open(os.path.join(ctx.chat_dir, "drafts.json"), "w") as f:
            json.dump(drafts, f)
    detail = {"run": run_id, "base": base, "head": head,
              "evals": evals or "suite"}
    if draft is not None:
        detail["scoped_eval"] = draft["name"]
    emit(ctx, "agent", "review_submitted", detail)
    return (f"review {run_id} submitted"
            + (f" with scoped eval {draft['name']}" if draft else "")
            + "; the deterministic pipeline will issue the verdict")


def draft_eval(ctx: SessionContext, origin: str, name: str, cmd: str,
               checks: dict, est_gpu_seconds: float) -> str:
    triage_path = os.path.join(ctx.chat_dir, "triage.json")
    try:
        with open(triage_path) as f:
            known = {a.get("id") for a in json.load(f)}
    except (FileNotFoundError, ValueError):
        known = None
    if known is not None and origin not in known:
        return f"unknown origin annotation {origin!r}; known: {sorted(known)}"
    if name in {e.get("name") for e in ctx.repo.get("evals", [])}:
        return f"an eval named {name!r} already exists in the suite"
    try:  # scoped-eval contract: declared harness only, ceiling-bounded knobs
        entry = validate_eval({"name": name, "cmd": cmd, "checks": checks})
        validate_scoped(entry, ctx.repo.get("evals", []))
    except ValueError as e:
        return f"draft rejected: {e}"

    drafts_path = os.path.join(ctx.chat_dir, "drafts.json")
    try:
        with open(drafts_path) as f:
            drafts = json.load(f)
    except (FileNotFoundError, ValueError):
        drafts = []
    if name in {d.get("name") for d in drafts}:
        return f"a draft named {name!r} already exists"
    draft = {"id": f"d{len(drafts) + 1}", "origin": origin, "name": name,
             "cmd": cmd, "checks": checks,
             "est_gpu_seconds": est_gpu_seconds, "status": "proposed"}
    drafts.append(draft)
    os.makedirs(ctx.chat_dir, exist_ok=True)
    with open(drafts_path, "w") as f:
        json.dump(drafts, f)
    emit(ctx, "agent", "eval_draft", dict(draft))
    return (f"draft {draft['id']} ({name}) recorded as proposed; a human "
            "approves it into the suite")


def release_sandbox(ctx: SessionContext) -> None:
    """Turn-end release: registry state -> cooldown (the sandboxes registry
    owns actual reaping; the sandbox also self-terminates at its timeout)."""
    if ctx.sandbox is None:
        return
    rel = ctx.sandbox_release or _default_sandbox_release
    try:
        rel(ctx.sandbox, ctx.sandbox_id)
    except Exception:
        pass  # registry update is best-effort; the event still lands
    emit(ctx, "system", "sandbox_released",
         {"sandbox_id": ctx.sandbox_id, "state": "cooldown",
          "cooldown_s": COOLDOWN_S})
    ctx.sandbox, ctx.sandbox_id, ctx.sandbox_gpu = None, None, None


def _default_sandbox_release(sb, sandbox_id: str) -> None:
    import modal  # lazy
    d = modal.Dict.from_name(DICT_SANDBOXES, create_if_missing=True)
    entry = dict(d.get(sandbox_id) or {})
    entry.update(state="cooldown", deadline=time.time() + COOLDOWN_S)
    d[sandbox_id] = entry


# --- Agents SDK wrappers -----------------------------------------------------

def make_tools(ctx: SessionContext) -> list:
    """Function tools for the session Agent, closing over one SessionContext."""

    @function_tool(name_override="set_status")
    def set_status_tool(text: str) -> str:
        """Show one sentence of visible reasoning to the user. Call this
        before EVERY other tool call.

        Args:
            text: one plain sentence: what you are about to do and why.
        """
        return set_status(ctx, text)

    @function_tool(name_override="decide_environment")
    def decide_environment_tool(kind: str, reason: str) -> str:
        """Pick the execution environment for this session's checks; the
        decision renders as a card with its estimated cost.

        Args:
            kind: "none" (answerable from the diff), "cpu" (imports,
                unit-level checks, host-side experiments), or a GPU type:
                "T4", "A10G", "A100".
            reason: one line justifying why this is the cheapest environment
                that answers the question.
        """
        return decide_environment(ctx, kind, reason)

    @function_tool(name_override="create_sandbox")
    def create_sandbox_tool() -> str:
        """Create the sandbox for the decided environment (max 1 live per
        session). GPU sandboxes may require human approval first.
        """
        return create_sandbox(ctx)

    @function_tool(name_override="exec")
    def exec_tool(cmd: str) -> str:
        """Run one bash command in the live sandbox; returns the exit code
        and a capped output tail.

        Args:
            cmd: the bash command (keep it small and bounded; clone with
                --depth 1, print tails not whole files).
        """
        return exec_cmd(ctx, cmd)

    @function_tool(name_override="run_eval", strict_mode=False)  # dict param
    def run_eval_tool(name: str, overrides: dict[str, float] | None = None) -> str:
        """Run one declared eval through the paired runner (base vs head) in
        the live sandbox; needs /work/base and /work/head checked out first.

        Args:
            name: a declared eval name from the suite.
            overrides: optional parameter overrides (tokens, repeats, batch,
                or a declared override knob).
        """
        return run_eval(ctx, name, overrides)

    @function_tool(name_override="submit_review")
    def submit_review_tool(base: str, head: str,
                           evals: list[str] | None = None,
                           include_draft: str | None = None) -> str:
        """Escalate to a formal review: the deterministic pipeline runs the
        suite and issues the verdict. One per turn.

        Args:
            base: base ref/sha to compare from.
            head: head ref/sha to verify.
            evals: optional subset of declared eval names (default: full suite).
            include_draft: a draft id from draft_eval to run with this review
                as a scoped, PR-proposed eval.
        """
        return submit_review(ctx, base, head, evals, include_draft)

    @function_tool(name_override="draft_eval", strict_mode=False)  # dict param
    def draft_eval_tool(origin: str, name: str, cmd: str,
                        checks: dict[str, str], est_gpu_seconds: float) -> str:
        """Draft a new eval in response to a triage coverage gap; it is
        recorded as proposed for human approval.

        Args:
            origin: the triage annotation id that demanded this eval.
            name: new eval name (must not collide with the suite).
            cmd: the bench command it would run.
            checks: metric -> threshold map (e.g. {"latency_ms_p95": "+15%"}).
            est_gpu_seconds: honest cost estimate for one run.
        """
        return draft_eval(ctx, origin, name, cmd, checks, est_gpu_seconds)

    return [set_status_tool, decide_environment_tool, create_sandbox_tool,
            exec_tool, run_eval_tool, submit_review_tool, draft_eval_tool]
