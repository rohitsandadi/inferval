"""Atlas JSON API (M4 backend). Mounted on Modal by controller/app.py via
`from atlas.api.api import web_app`.

A thin file-server over the run-dir layout documented in contracts/names.py.
All state is files under the runs root (env ATLAS_RUNS_ROOT, default /runs).
The two Modal touchpoints — spawn the controller, set an approval key — sit
behind module-level hooks (`spawn_controller`, `set_approval`) with lazy
modal imports so tests monkeypatch them and never load Modal.

Cross-module exception, agreed in the plan: atlas.referee.events is imported
here (pure stdlib, no Modal) so the proposal decision lands in events.jsonl.
"""
import datetime
import json
import os
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from atlas.contracts.names import (APP_NAME, CONTROLLER_FUNCTION,
                                   DICT_APPROVALS, ENV_RUNS_ROOT, VOLUME_RUNS)
from atlas.contracts.types import SCHEMA_VERSION
from atlas.contracts.validate import validate
from atlas.referee.events import append_event

A10G_USD_PER_H = 1.10          # crude cost basis for the run-page chip
ARTIFACT_CAP = 256 * 1024      # bytes served per artifact request
HEADLINE_METRICS = ("tokens_per_s", "latency_ms_p95", "peak_vram_mb")

web_app = FastAPI(title="atlas")
web_app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])


# --- Modal hooks (monkeypatched in tests) ----------------------------------

def _default_spawn(spec: dict) -> None:
    import modal  # lazy: only reachable on Modal / with credentials
    modal.Function.from_name(APP_NAME, CONTROLLER_FUNCTION).spawn(spec)


def _default_set_approval(run_id: str, proposal_id: str, decision: str) -> None:
    import modal  # lazy, same reason
    d = modal.Dict.from_name(DICT_APPROVALS, create_if_missing=True)
    d[f"{run_id}:{proposal_id}"] = decision


spawn_controller = _default_spawn
set_approval = _default_set_approval

_last_reload = 0.0


def _maybe_reload() -> None:
    """On Modal the runs Volume is written by another container; refresh it
    before reads, at most once a second. Local no-op without ATLAS_ON_MODAL."""
    global _last_reload
    if not os.environ.get("ATLAS_ON_MODAL"):
        return
    now = time.time()
    if now - _last_reload < 1.0:
        return
    _last_reload = now
    try:
        import modal
        modal.Volume.from_name(VOLUME_RUNS).reload()
    except Exception:
        pass  # stale reads beat a dead API


# --- file plumbing ----------------------------------------------------------

def _runs_root() -> str:
    return os.environ.get(ENV_RUNS_ROOT, "/runs")


def _run_dir(run_id: str) -> str:
    d = os.path.join(_runs_root(), run_id)
    if not os.path.isdir(d):
        raise HTTPException(404, f"run {run_id} not found")
    return d


def _read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def _read_raw_lines(run_dir: str) -> list[str]:
    """Complete lines of events.jsonl, raw. A partially-written trailing line
    (no newline yet) is not served, so the cursor never advances past it."""
    try:
        with open(os.path.join(run_dir, "events.jsonl")) as f:
            raw = f.read()
    except FileNotFoundError:
        return []
    out = []
    for line in raw.splitlines(keepends=True):
        if not line.endswith("\n"):
            break
        out.append(line)
    return out


def _read_event_lines(run_dir: str) -> list:
    """Complete lines, parsed (None for an unparsable line)."""
    lines = []
    for line in _read_raw_lines(run_dir):
        try:
            lines.append(json.loads(line))
        except ValueError:
            lines.append(None)
    return lines


def _parse_t(t):
    try:
        return datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        return None


# Lifecycle kind -> UI status chip. Explicit `status` events still win.
_KIND_STATUS = {"submitted": "queued", "plan": "provisioning",
                "plan_fallback": "provisioning", "sandbox_up": "ready",
                "revisions_ready": "ready", "preflight_ok": "measuring",
                "bench_block_done": "measuring", "verdict": "verdict",
                "investigation_started": "investigating",
                "probe_proposed": "investigating", "probe_done": "investigating",
                "investigation_done": "investigating",
                "report_ready": "done", "terminated": "done"}


def _derive_status(events: list) -> str:
    status = None
    saw_verdict = False
    for e in events:
        if not e:
            continue
        kind = e.get("kind")
        if kind == "status":
            status = e.get("detail", {}).get("status") or status
        elif kind in _KIND_STATUS:
            # probe blocks re-run the bench pipeline mid-investigation; they
            # must not flip a post-verdict run back to "measuring"
            if saw_verdict and _KIND_STATUS[kind] == "measuring":
                continue
            status = _KIND_STATUS[kind]
        if kind == "verdict":
            saw_verdict = True
    return status or ("running" if events else "queued")


def _duration_s(events: list):
    ts = [t for t in (_parse_t(e.get("t")) for e in events if e) if t]
    if len(ts) < 2:
        return None
    return (max(ts) - min(ts)).total_seconds()


def _headline_deltas(verdict) -> dict:
    """Per headline metric, the largest swing across evals (the number the
    runs table shows)."""
    deltas: dict = {}
    for c in (verdict or {}).get("checks", []):
        m, d = c.get("metric"), c.get("delta_pct")
        if m in HEADLINE_METRICS and d is not None:
            if m not in deltas or abs(d) > abs(deltas[m]):
                deltas[m] = d
    return deltas


def _load_repos() -> list:
    with open(os.path.join(os.path.dirname(__file__), "repos.json")) as f:
        repos = json.load(f)["repos"]
    d = os.path.join(_runs_root(), "repos.d")  # OAuth-connected repos
    if os.path.isdir(d):
        seen = {r["name"] for r in repos}
        for fn in sorted(os.listdir(d)):
            entry = _read_json(os.path.join(d, fn))
            if entry and entry.get("name") not in seen:
                repos.append(entry)
    return repos


def _scan_runs() -> list:
    """Every run dir with a spec.json, oldest first."""
    root = _runs_root()
    out = []
    if not os.path.isdir(root):
        return out
    for run_id in os.listdir(root):
        d = os.path.join(root, run_id)
        spec = _read_json(os.path.join(d, "spec.json"))
        if spec is None:
            continue
        events = _read_event_lines(d)
        starts = [t for t in (_parse_t(e.get("t")) for e in events if e) if t]
        key = min(starts).timestamp() if starts else os.path.getmtime(
            os.path.join(d, "spec.json"))
        out.append({"run": run_id, "spec": spec, "events": events,
                    "verdict": _read_json(os.path.join(d, "verdict.json")),
                    "sort_key": key})
    out.sort(key=lambda r: r["sort_key"])
    return out


def _repo_matches(spec_repo: str, name: str) -> bool:
    r = (spec_repo or "").removesuffix(".git")
    return r == name or r.endswith("/" + name)


def _run_row(r: dict) -> dict:
    """One run as the UI's RunSummary shape (web/lib/types.ts)."""
    spec, verdict = r["spec"], r["verdict"]
    deltas = _headline_deltas(verdict)
    dur = _duration_s(r["events"])
    starts = [t for t in (_parse_t(e.get("t")) for e in r["events"] if e) if t]
    return {"run": r["run"],
            "mode": spec.get("mode"),
            "branch": spec.get("branch"),
            "base_sha": spec.get("base_sha"),
            "head_sha": spec.get("head_sha"),
            "selection": spec.get("selection"),
            "claim": spec.get("claim"),
            "verdict": verdict["verdict"] if verdict else None,
            "flagged": any(c.get("flagged")
                           for c in (verdict or {}).get("checks", [])),
            "tokens_per_s_delta_pct": deltas.get("tokens_per_s"),
            "p95_delta_pct": deltas.get("latency_ms_p95"),
            "vram_delta_pct": deltas.get("peak_vram_mb"),
            "status": _derive_status(r["events"]),
            "duration_s": dur,
            "cost_usd": round(dur / 3600.0 * A10G_USD_PER_H, 2) if dur else None,
            "created_at": min(starts).isoformat() if starts else None}


# --- routes -----------------------------------------------------------------

@web_app.get("/api/health")
def health():
    return {"ok": True}


@web_app.get("/api/repos")
def repos():
    """Bare RepoInfo[] per web/lib/types.ts; eval suites reduced to names."""
    _maybe_reload()
    entries = [dict(r, evals=[e["name"] for e in r.get("evals", [])],
                    runs_count=0, last_run=None)
               for r in _load_repos()]
    for r in _scan_runs():  # oldest first, so the last hit wins "last_run"
        row = _run_row(r)
        matched = [e for e in entries if _repo_matches(r["spec"].get("repo", ""),
                                                       e["name"])]
        if not matched:  # orphan run (e.g. a CLI/ephemeral spec with a raw
            continue     # URL): count it nowhere rather than synthesize a
                         # phantom repo card; connected repos come only from
                         # repos.json + repos.d.
        for e in matched:
            e["runs_count"] += 1
            e["last_run"] = {"run": row["run"], "verdict": row["verdict"],
                             "status": row["status"], "t": row["created_at"]}
    return entries


@web_app.get("/api/repos/{name:path}/branches")
def repo_branches(name: str, base: str = None):
    """BranchInfo[] per the frozen seam in v2/UI_PLAN.md. Static branch/PR
    facts live in repos.json; state derives from the run scan: a run reviews
    a branch when its repo matches, its branch or head ref names the branch,
    and its base matches ?base (default: the repo's default_branch).

    Route order vs /runs is immaterial: the path converter compiles each to
    a regex with a distinct literal suffix, so both always resolve.
    """
    _maybe_reload()
    repo = next((r for r in _load_repos() if r["name"] == name), None)
    if repo is None:
        raise HTTPException(404, f"unknown repo: {name}")
    base_ref = base or repo.get("default_branch")
    runs = _scan_runs()  # oldest first; the last hit is the newest review
    out = []
    for b in repo.get("branches", []):
        hits = [r for r in runs
                if _repo_matches(r["spec"].get("repo", ""), name)
                and b["name"] in (r["spec"].get("branch"),
                                  r["spec"].get("head_sha"))
                and r["spec"].get("base_sha") == base_ref]
        last = None
        state = "unverified"
        if hits:
            row = _run_row(hits[-1])
            done = row["status"] == "done"
            verdict = row["verdict"] if done else None  # null while running
            if not done:
                state = "running"
            elif verdict == "pass":
                state = "verified"
            elif verdict in ("regression", "invalid"):
                state = "regression"
            last = {"run": row["run"], "verdict": verdict,
                    "tokens_per_s_delta_pct": row["tokens_per_s_delta_pct"],
                    "status": row["status"], "t": row["created_at"]}
        out.append({"name": b["name"], "sha": b["sha"], "pr": b.get("pr"),
                    "state": state, "last_review": last,
                    "reviews_count": len(hits)})
    return out


@web_app.get("/api/repos/{name:path}/runs")
def repo_runs(name: str):
    _maybe_reload()
    rows = [_run_row(r) for r in _scan_runs()
            if _repo_matches(r["spec"].get("repo", ""), name)]
    return rows[::-1]  # newest first


@web_app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    _maybe_reload()
    d = _run_dir(run_id)
    events = _read_event_lines(d)
    dur = _duration_s(events)
    return {"spec": _read_json(os.path.join(d, "spec.json")),
            "verdict": _read_json(os.path.join(d, "verdict.json")),
            "status": _derive_status(events),
            "duration_s": dur,
            "cost_usd": round(dur / 3600.0 * A10G_USD_PER_H, 2)
                        if dur else None}


@web_app.get("/api/runs/{run_id}/events")
def run_events(run_id: str, since: int = 0):
    """JSONL text from complete line N on; the client's cursor is how many
    lines it has received so far (IMPLEMENTATION M4)."""
    _maybe_reload()
    lines = _read_raw_lines(_run_dir(run_id))
    return Response(content="".join(lines[max(0, since):]),
                    media_type="application/x-ndjson")


@web_app.get("/api/runs/{run_id}/report")
def run_report(run_id: str):
    _maybe_reload()
    report = _read_json(os.path.join(_run_dir(run_id), "report.json"))
    if report is None:
        raise HTTPException(404, "report not ready")
    return report


@web_app.get("/api/runs/{run_id}/artifact")
def run_artifact(run_id: str, path: str):
    _maybe_reload()
    d = _run_dir(run_id)
    if os.path.isabs(path):
        raise HTTPException(400, "absolute paths not allowed")
    real_dir = os.path.realpath(d)
    target = os.path.realpath(os.path.join(real_dir, path))
    if not target.startswith(real_dir + os.sep):
        raise HTTPException(400, "path escapes run dir")
    if not os.path.isfile(target):
        raise HTTPException(404, "artifact not found")
    with open(target, "rb") as f:
        data = f.read(ARTIFACT_CAP)  # bounded serving; big files truncate
    media = ("application/json" if target.endswith(".json") else "text/plain")
    return Response(content=data, media_type=media)


@web_app.post("/api/runs")
def create_run(body: dict):
    repo_name = body.get("repo")
    repo = next((r for r in _load_repos() if r["name"] == repo_name), None)
    if repo is None:
        raise HTTPException(404, f"unknown repo: {repo_name}")
    mode = body.get("mode")
    if mode not in ("compare", "check"):
        raise HTTPException(422, "mode must be 'compare' or 'check'")
    selection = body.get("selection", "auto")
    if selection not in ("all", "pick", "auto"):
        raise HTTPException(422, "selection must be 'all', 'pick' or 'auto'")
    approvals = body.get("approvals") or repo.get("approvals", "manual")
    if approvals not in ("auto", "manual"):
        raise HTTPException(422, "approvals must be 'auto' or 'manual'")
    if not body.get("base_sha"):
        raise HTTPException(422, "base_sha required")
    if mode == "compare" and not body.get("head_sha"):
        raise HTTPException(422, "head_sha required in compare mode")

    suite = repo.get("evals", [])
    if selection == "pick":
        picked = body.get("evals") or []
        unknown = [n for n in picked if n not in {e["name"] for e in suite}]
        if not picked:
            raise HTTPException(422, "pick selection needs a non-empty evals list")
        if unknown:
            raise HTTPException(422, f"unknown evals: {unknown}")
        evals = [e for e in suite if e["name"] in set(picked)]
    else:  # all/auto ship the declared suite; auto is narrowed by the planner
        evals = list(suite)

    run_id = "r_" + uuid.uuid4().hex[:8]
    spec = {"schema": SCHEMA_VERSION, "run": run_id, "mode": mode,
            "repo": repo.get("url", repo_name),  # the controller clones this
            "base_sha": body["base_sha"],
            "gpu": repo["gpu"], "image": repo["image"], "evals": evals,
            "selection": selection, "approvals": approvals,
            "overrides": repo.get("overrides", [])}  # probe whitelist
    if mode == "compare":
        spec["head_sha"] = body["head_sha"]
    for k in ("claim", "branch", "diff", "patch"):  # patch/diff: demo hooks
        if body.get(k):
            spec[k] = body[k]
    validate(spec, "run_spec")
    try:
        spawn_controller(spec)
    except Exception as e:
        raise HTTPException(502, f"controller spawn failed: {e}")
    return {"run": run_id}


@web_app.post("/api/runs/{run_id}/proposals/{proposal_id}")
def decide_proposal(run_id: str, proposal_id: str, body: dict):
    decision = body.get("decision")
    if decision not in ("approved", "denied"):
        raise HTTPException(422, "decision must be 'approved' or 'denied'")
    _run_dir(run_id)  # 404 before any side effect
    try:
        set_approval(run_id, proposal_id, decision)
    except Exception as e:
        raise HTTPException(502, f"approval write failed: {e}")
    append_event(_runs_root(), run_id, "human",
                 "proposal_approved" if decision == "approved"
                 else "proposal_denied",
                 {"id": proposal_id, "by": "api"})
    return {"ok": True, "run": run_id, "proposal": proposal_id,
            "decision": decision}


# --- parallel-work routers --------------------------------------------------
# sessions (agent loop) and sandboxes (warm pool) land as separate modules;
# guarded imports so a half-built module never breaks the app.
import importlib

for _mod in ("atlas.api.sessions", "atlas.api.sandboxes",
             "atlas.api.github_auth"):
    try:
        web_app.include_router(importlib.import_module(_mod).router)
    except Exception:
        pass
