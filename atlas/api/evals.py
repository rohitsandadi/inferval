"""Per-repo eval store. Exported as `router`; api.py's loop mounts it.

Evals created here persist on the runs volume at
  <runs root>/evals.d/<owner>__<repo>/<eval_name>.json
and overlay the repo's seeded suite (repos.json / the repo's yaml) by name —
the store wins. This is what the MCP server and the Evals page write to, so
an agent can define a repo's evals without touching the repo itself.
"""
import json
import os
import time

from fastapi import APIRouter, HTTPException

from atlas.contracts.evalspec import validate_eval
from atlas.contracts.names import ENV_RUNS_ROOT, VOLUME_RUNS

router = APIRouter(prefix="/api")

_last_reload = 0.0


def _maybe_reload() -> None:
    """Freshen the runs Volume before reads on Modal, at most once a second
    (same pattern as api.py/sessions.py; local no-op without ATLAS_ON_MODAL)."""
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


def _runs_root() -> str:
    return os.environ.get(ENV_RUNS_ROOT, "/runs")


def store_dir(repo_name: str) -> str:
    return os.path.join(_runs_root(), "evals.d", repo_name.replace("/", "__"))


def store_evals(repo_name: str) -> list[dict]:
    """All store evals for a repo, name-sorted. Shared with _load_repos
    overlays (api.py / sessions.py read this via their own copies of the
    same three lines to keep module isolation)."""
    d = store_dir(repo_name)
    out = []
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            try:
                with open(os.path.join(d, fn)) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                continue
    return out


def _commit_volume() -> None:
    """Publish a store write to every container. reload() alone (the old
    body) never persisted anything — other API containers flapped between
    seeing and not seeing new evals until this actually commits."""
    try:
        import modal
        modal.Volume.from_name(VOLUME_RUNS).commit()
    except Exception:
        pass


def _load_repo_names() -> set[str]:
    here = os.path.dirname(__file__)
    with open(os.path.join(here, "repos.json")) as f:
        names = {r["name"] for r in json.load(f)["repos"]}
    d = os.path.join(_runs_root(), "repos.d")
    if os.path.isdir(d):
        for fn in os.listdir(d):
            try:
                with open(os.path.join(d, fn)) as f:
                    names.add(json.load(f)["name"])
            except (OSError, ValueError, KeyError):
                continue
    removed_dir = os.path.join(_runs_root(), "repos.removed")
    if os.path.isdir(removed_dir):
        for fn in os.listdir(removed_dir):
            try:
                with open(os.path.join(removed_dir, fn)) as f:
                    names.discard(json.load(f)["name"])
            except (OSError, ValueError, KeyError):
                continue
    return names


@router.get("/repos/{name:path}/evals")
def list_evals(name: str):
    _maybe_reload()
    if name not in _load_repo_names():
        raise HTTPException(404, f"unknown repo: {name}")
    return store_evals(name)


@router.post("/repos/{name:path}/evals")
def create_eval(name: str, body: dict):
    """Create or replace one eval. Body: {name, cmd, checks, absolute?,
    origin?}. checks: metric -> \"+15%\"/\"-10%\"; absolute: metric -> \"<3000\"."""
    if name not in _load_repo_names():
        raise HTTPException(404, f"unknown repo: {name}")
    try:
        entry = validate_eval(body)  # shared rules (contracts/evalspec)
    except ValueError as e:
        raise HTTPException(422, str(e))
    os.makedirs(store_dir(name), exist_ok=True)
    with open(os.path.join(store_dir(name), entry["name"] + ".json"), "w") as f:
        json.dump(entry, f)
    _commit_volume()
    return entry


@router.delete("/repos/{name:path}/evals/{ev_name}")
def delete_eval(name: str, ev_name: str):
    path = os.path.join(store_dir(name), ev_name + ".json")
    if not os.path.isfile(path):
        raise HTTPException(404, "no such stored eval (seeded evals from the "
                                 "repo's yaml can't be deleted here)")
    os.remove(path)
    _commit_volume()
    return {"deleted": ev_name}
