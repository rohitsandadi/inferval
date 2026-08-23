"""Warm-sandbox pool API. Auto-mounted by atlas/api/api.py (it imports this
module's `router`).

A thin view over the atlas-sandboxes Dict (contracts/names.py): entries are
registered by the controller (runs) and the session agent (sessions) and are
served unchanged — attached may be {"run": id}, {"session": id}, or null.
The two Modal touchpoints — read the registry, control one sandbox — sit
behind module-level hooks (`pool_entries`, `sandbox_control`) with lazy modal
imports so tests monkeypatch them and never load Modal.
"""
import datetime

from fastapi import APIRouter, HTTPException

from atlas.contracts.names import DICT_SANDBOXES

EXTEND_S = 600  # one "extend" pushes the cooldown deadline this much further

router = APIRouter()


# --- Modal hooks (monkeypatched in tests) ----------------------------------

def _default_pool_entries() -> dict:
    import modal  # lazy: only reachable on Modal / with credentials
    d = modal.Dict.from_name(DICT_SANDBOXES, create_if_missing=True)
    return {k: v for k, v in d.items()}


def _default_sandbox_control(sandbox_id: str, action: str) -> dict:
    import modal  # lazy, same reason
    d = modal.Dict.from_name(DICT_SANDBOXES, create_if_missing=True)
    e = dict(d.get(sandbox_id) or {})
    if action == "stop":
        try:
            modal.Sandbox.from_id(sandbox_id).terminate()
        except Exception:
            pass  # already gone; the registry record still flips
        e["state"] = "terminated"
    else:  # extend
        e["deadline"] = (e.get("deadline") or 0) + EXTEND_S
    d[sandbox_id] = e
    return e


pool_entries = _default_pool_entries
sandbox_control = _default_sandbox_control


# --- shaping ----------------------------------------------------------------

def _repo_matches(spec_repo: str, name: str) -> bool:
    # same suffix-match as api.py (tiny helper copied by agreement, not imported)
    r = (spec_repo or "").removesuffix(".git")
    return r == name or r.endswith("/" + name)


def _parse_t(t):
    try:
        return datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        return None


def _row(sandbox_id: str, e: dict) -> dict:
    """One registry entry as the UI's sandbox shape. uptime_s only while the
    sandbox exists (running/cooldown); terminated rows report null."""
    uptime = None
    created = _parse_t(e.get("created_at"))
    if created is not None and e.get("state") in ("running", "cooldown"):
        try:
            now = datetime.datetime.now(datetime.timezone.utc)
            uptime = max(0, int((now - created).total_seconds()))
        except TypeError:  # naive created_at from a foreign writer
            uptime = None
    return {"id": sandbox_id, "gpu": e.get("gpu"), "state": e.get("state"),
            "created_at": e.get("created_at"), "deadline": e.get("deadline"),
            "attached": e.get("attached"), "uptime_s": uptime}


# --- routes -----------------------------------------------------------------

@router.get("/api/repos/{name:path}/sandboxes")
def repo_sandboxes(name: str):
    try:
        entries = pool_entries()
    except Exception as e:
        raise HTTPException(502, f"sandbox pool unavailable: {e}")
    rows = [_row(sid, e) for sid, e in sorted(entries.items())
            if isinstance(e, dict) and _repo_matches(e.get("repo", ""), name)]
    rows.sort(key=lambda r: r["created_at"] or "", reverse=True)  # newest first
    return rows


@router.post("/api/sandboxes/{sandbox_id}")
def control_sandbox(sandbox_id: str, body: dict):
    action = (body or {}).get("action")
    if action not in ("stop", "extend"):
        raise HTTPException(422, "action must be 'stop' or 'extend'")
    try:
        entries = pool_entries()
    except Exception as e:
        raise HTTPException(502, f"sandbox pool unavailable: {e}")
    if sandbox_id not in entries:
        raise HTTPException(404, f"unknown sandbox: {sandbox_id}")
    try:
        entry = sandbox_control(sandbox_id, action)
    except Exception as e:
        raise HTTPException(502, f"sandbox control failed: {e}")
    return {"ok": True, "id": sandbox_id, "action": action,
            "sandbox": _row(sandbox_id,
                            entry if isinstance(entry, dict) else {})}
