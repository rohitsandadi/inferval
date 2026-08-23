"""Per-repo eval store. Exported as `router`; api.py's loop mounts it.

Evals created here persist on the runs volume at
  <runs root>/evals.d/<owner>__<repo>/<eval_name>.json
and overlay the repo's seeded suite (repos.json / the repo's yaml) by name —
the store wins. This is what the MCP server and the Evals page write to, so
an agent can define a repo's evals without touching the repo itself.
"""
import json
import os
import re

from fastapi import APIRouter, HTTPException

from atlas.contracts.names import ENV_RUNS_ROOT

router = APIRouter(prefix="/api")

# Mirrors the referee's metric registry (atlas/referee/policy.py); kept in
# sync by hand so an unknown metric fails here, not as an invalid verdict.
KNOWN_METRICS = ("tokens_per_s", "latency_ms_median", "latency_ms_p95",
                 "peak_vram_mb")
REL_RE = re.compile(r"^[+-]\d+(\.\d+)?%$")
ABS_RE = re.compile(r"^(<=|>=|<|>)\d+(\.\d+)?$")
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,40}$")


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
    try:
        import modal
        from atlas.contracts.names import VOLUME_RUNS
        modal.Volume.from_name(VOLUME_RUNS).reload()  # freshen, then write wins
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
    if name not in _load_repo_names():
        raise HTTPException(404, f"unknown repo: {name}")
    return store_evals(name)


@router.post("/repos/{name:path}/evals")
def create_eval(name: str, body: dict):
    """Create or replace one eval. Body: {name, cmd, checks, absolute?,
    origin?}. checks: metric -> \"+15%\"/\"-10%\"; absolute: metric -> \"<3000\"."""
    if name not in _load_repo_names():
        raise HTTPException(404, f"unknown repo: {name}")
    ev_name = body.get("name") or ""
    if not NAME_RE.fullmatch(ev_name):
        raise HTTPException(422, "eval name: lowercase letters, digits, _")
    cmd = (body.get("cmd") or "").strip()
    if not cmd or "{out}" not in cmd:
        raise HTTPException(422, "cmd required and must contain {out}")
    checks = body.get("checks") or {}
    absolute = body.get("absolute") or {}
    if not checks and not absolute:
        raise HTTPException(422, "at least one check or absolute required")
    for metric, thr in checks.items():
        if metric not in KNOWN_METRICS:
            raise HTTPException(422, f"unknown metric: {metric}")
        if not isinstance(thr, str) or not REL_RE.fullmatch(thr):
            raise HTTPException(422, f"bad relative threshold for {metric}: "
                                     f"{thr!r} (form: \"-10%\" / \"+15%\")")
    for metric, expr in absolute.items():
        if metric not in KNOWN_METRICS:
            raise HTTPException(422, f"unknown metric: {metric}")
        if not isinstance(expr, str) or not ABS_RE.fullmatch(expr):
            raise HTTPException(422, f"bad absolute bound for {metric}: "
                                     f"{expr!r} (form: \"<3000\")")
    entry = {"name": ev_name, "cmd": cmd, "checks": checks}
    if absolute:
        entry["absolute"] = absolute
    if body.get("origin"):
        entry["origin"] = body["origin"]  # e.g. "pr:1" for gap-born evals
    os.makedirs(store_dir(name), exist_ok=True)
    with open(os.path.join(store_dir(name), ev_name + ".json"), "w") as f:
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
