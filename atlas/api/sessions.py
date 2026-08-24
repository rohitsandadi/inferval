"""Session API routes. Exported as `router`; api.py's router loop mounts it
automatically — this module never imports api.py (own copies of the tiny
helpers, per the module-isolation rule).

Storage: <runs root>/chats/<chat_id>/ with events.jsonl (same Event contract
as runs), meta.json, triage.json, drafts.json. The two side-effect
touchpoints — spawning a turn on Modal and fetching a PR from GitHub — sit
behind module-level hooks (`spawn_turn`, `fetch_pr`) with lazy imports so
tests monkeypatch them and never load Modal or the network.
"""
import datetime
import json
import os
import time
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from atlas.contracts.names import (APP_NAME, CHAT_TURN_FUNCTION,
                                   ENV_RUNS_ROOT, VOLUME_RUNS)

router = APIRouter(prefix="/api")


# --- hooks (monkeypatched in tests) -----------------------------------------

def _default_spawn_turn(chat_id: str, text: str, directive: bool = False) -> None:
    import modal  # lazy: only reachable on Modal / with credentials
    modal.Function.from_name(APP_NAME, CHAT_TURN_FUNCTION).spawn(
        chat_id, text, directive=directive)


def _default_fetch_pr(repo_name: str, number: int, cache_dir: str) -> dict:
    from atlas.session.github import fetch_pr as fetch  # lazy: needs httpx
    return fetch(repo_name, number, cache_dir=cache_dir)


spawn_turn = _default_spawn_turn
fetch_pr = _default_fetch_pr

def _commit_volume() -> None:
    """Publish session writes to every container before a worker is spawned
    to read them — an uncommitted meta.json is invisible to the turn function
    and the turn dies before its first event (the silent-review_pr bug)."""
    try:
        import modal
        modal.Volume.from_name(VOLUME_RUNS).commit()
    except Exception:
        pass


_last_reload = 0.0


def _maybe_reload() -> None:
    """Refresh the runs Volume before reads on Modal, at most once a second
    (same pattern as api.py; local no-op without ATLAS_ON_MODAL)."""
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


# --- file plumbing (own copies; modules don't import each other) ------------

def _runs_root() -> str:
    return os.environ.get(ENV_RUNS_ROOT, "/runs")


def _chats_root() -> str:
    return os.path.join(_runs_root(), "chats")


def _chat_dir(chat_id: str) -> str:
    d = os.path.join(_chats_root(), chat_id)
    if not os.path.isdir(d):
        raise HTTPException(404, f"session {chat_id} not found")
    return d


def _read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def _read_raw_lines(chat_dir: str) -> list[str]:
    """Complete lines of events.jsonl, raw; a partially-written trailing line
    is not served, so the cursor never advances past it (parity with runs)."""
    try:
        with open(os.path.join(chat_dir, "events.jsonl")) as f:
            raw = f.read()
    except FileNotFoundError:
        return []
    out = []
    for line in raw.splitlines(keepends=True):
        if not line.endswith("\n"):
            break
        out.append(line)
    return out


def _load_repos() -> list:
    with open(os.path.join(os.path.dirname(__file__), "repos.json")) as f:
        repos = json.load(f)["repos"]
    removed = set()
    removed_dir = os.path.join(_runs_root(), "repos.removed")
    if os.path.isdir(removed_dir):
        for fn in os.listdir(removed_dir):
            marker = _read_json(os.path.join(removed_dir, fn))
            if marker and marker.get("name"):
                removed.add(marker["name"])
    repos = [repo for repo in repos if repo.get("name") not in removed]
    d = os.path.join(_runs_root(), "repos.d")  # OAuth-connected repos
    if os.path.isdir(d):
        seen = {r["name"] for r in repos}
        for fn in sorted(os.listdir(d)):
            entry = _read_json(os.path.join(d, fn))
            if (entry and entry.get("name") not in removed
                    and entry.get("name") not in seen):
                repos.append(entry)
    d2 = os.path.join(_runs_root(), "evals.d")  # agent/UI-created evals win
    if os.path.isdir(d2):
        for r in repos:
            sd = os.path.join(d2, r["name"].replace("/", "__"))
            if not os.path.isdir(sd):
                continue
            by_name = {e["name"]: e for e in r.get("evals", [])}
            for fn in sorted(os.listdir(sd)):
                try:
                    with open(os.path.join(sd, fn)) as f:
                        e = json.load(f)
                    by_name[e["name"]] = e
                except (OSError, ValueError, KeyError):
                    continue
            r["evals"] = list(by_name.values())
    return repos


# --- routes -----------------------------------------------------------------

@router.post("/repos/{name:path}/sessions")
def create_session(name: str, body: dict):
    """Create a session attached to a change: {pr?: int, branch?: str}.
    Fetches PR meta + diff from the GitHub REST API when pr is given, with
    repos.json as the offline fallback."""
    repo = next((r for r in _load_repos() if r["name"] == name), None)
    if repo is None:
        raise HTTPException(404, f"unknown repo: {name}")
    pr_num = body.get("pr")
    branch = body.get("branch")
    if pr_num is not None and (not isinstance(pr_num, int)
                               or isinstance(pr_num, bool)):
        raise HTTPException(422, "pr must be an integer")
    if branch is not None and not isinstance(branch, str):
        raise HTTPException(422, "branch must be a string")

    chat_id = "c_" + uuid.uuid4().hex[:8]
    d = os.path.join(_chats_root(), chat_id)
    os.makedirs(d, exist_ok=True)

    pr_meta = None
    if pr_num is not None:
        try:
            fetched = fetch_pr(name, pr_num, d)
            pr_meta = {k: fetched.get(k)
                       for k in ("number", "title", "url", "body", "head", "base")}
            branch = branch or fetched.get("head_ref")
        except Exception:  # offline / rate-limited: fall back to repos.json
            b = next((b for b in repo.get("branches", [])
                      if (b.get("pr") or {}).get("number") == pr_num), None)
            info = (b or {}).get("pr") or {}
            pr_meta = {"number": pr_num, "title": info.get("title"),
                       "url": info.get("url"), "body": info.get("claim"),
                       "head": (b or {}).get("sha"),
                       "base": repo.get("default_branch")}
            branch = branch or (b or {}).get("name")

    meta = {"session": chat_id, "repo": name, "pr": pr_meta, "branch": branch,
            "created_at": datetime.datetime.now(datetime.timezone.utc)
                                           .isoformat(timespec="seconds"),
            "status": "created"}
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f)
    _commit_volume()
    return {"session": chat_id}


@router.post("/repos/{name:path}/prs/{number}/review")
def review_pr(name: str, number: int):
    """The "Review this PR" trigger: create a session attached to the PR and
    spawn one background worker turn (no chat message). The worker triages,
    decides coverage, may draft one constrained scoped eval, and submits the
    formal review; its artifacts land in the session's event stream."""
    created = create_session(name, {"pr": number})
    chat_id = created["session"]
    try:
        spawn_turn(chat_id, "", directive=True)
    except Exception as e:
        raise HTTPException(502, f"worker spawn failed: {e}")
    return {"session": chat_id}


@router.post("/sessions/{chat_id}/review")
def review_session(chat_id: str):
    """Trigger the background review worker on an existing session (the PR
    page's Review button; the /prs/{n}/review route is the create-and-run
    variant for API/MCP callers)."""
    d = _chat_dir(chat_id)
    meta = _read_json(os.path.join(d, "meta.json")) or {}
    if not (meta.get("pr") or meta.get("branch")):
        raise HTTPException(422, "session has no change attached to review")
    try:
        spawn_turn(chat_id, "", directive=True)
    except Exception as e:
        raise HTTPException(502, f"worker spawn failed: {e}")
    return {"session": chat_id}


@router.get("/repos/{name:path}/sessions")
def list_sessions(name: str):
    """Sessions for a repo, newest first: what the PR page opens or reuses."""
    _maybe_reload()
    root = _chats_root()
    out = []
    if not os.path.isdir(root):
        return out
    for chat_id in os.listdir(root):
        meta = _read_json(os.path.join(root, chat_id, "meta.json"))
        if not meta or meta.get("repo") != name:
            continue
        pr = meta.get("pr") or None
        out.append({"session": chat_id,
                    "pr": {k: pr.get(k) for k in ("number", "title", "url")}
                          if pr else None,
                    "branch": meta.get("branch"),
                    "created_at": meta.get("created_at"),
                    "status": meta.get("status", "created")})
    out.sort(key=lambda s: s.get("created_at") or "", reverse=True)
    return out


@router.get("/sessions/{chat_id}/diff")
def session_diff(chat_id: str):
    """The attached PR's unified diff, text/plain (cached at attach time)."""
    _maybe_reload()
    path = os.path.join(_chat_dir(chat_id), "pr.diff")
    if not os.path.isfile(path):
        raise HTTPException(404, "no diff attached")
    with open(path, "rb") as f:
        return Response(content=f.read(256 * 1024), media_type="text/plain")


@router.post("/sessions/{chat_id}/messages")
def post_message(chat_id: str, body: dict):
    """One user message -> one spawned turn (chat_turn on Modal via the
    spawn_turn hook). Returns the turn number the spawned turn will get."""
    d = _chat_dir(chat_id)
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(422, "text required")
    turn = 1
    for line in _read_raw_lines(d):
        try:
            if json.loads(line).get("kind") in ("user_message",
                                                "review_requested"):
                turn += 1
        except ValueError:
            continue
    try:
        spawn_turn(chat_id, text)
    except Exception as e:
        raise HTTPException(502, f"turn spawn failed: {e}")
    return {"turn": turn}


@router.get("/sessions/{chat_id}/events")
def session_events(chat_id: str, since: int = 0):
    """JSONL text from complete line N on — exactly the runs events route's
    cursor semantics."""
    _maybe_reload()
    lines = _read_raw_lines(_chat_dir(chat_id))
    return Response(content="".join(lines[max(0, since):]),
                    media_type="application/x-ndjson")


@router.get("/sessions/{chat_id}")
def session_detail(chat_id: str):
    _maybe_reload()
    d = _chat_dir(chat_id)
    meta = _read_json(os.path.join(d, "meta.json")) or {}
    return {"session": chat_id,
            "repo": meta.get("repo"),
            "pr": meta.get("pr"),
            "branch": meta.get("branch"),
            "triage": _read_json(os.path.join(d, "triage.json")),
            "drafts": _read_json(os.path.join(d, "drafts.json")) or [],
            "status": meta.get("status", "created")}
