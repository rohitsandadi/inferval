"""Single-user GitHub OAuth + repo connect (v2/GITHUB_OAUTH.md).

No user system: one operator, one token, stored server-side in the
`atlas-github` Modal Dict. The token never reaches the frontend; GitHub
calls proxy through here. Network and Modal touchpoints sit behind
module-level hooks (`exchange_code`, `gh_get`, `store`) so tests
monkeypatch them.
"""
import json
import os
import re
import secrets as pysecrets
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

from atlas.contracts.names import ENV_RUNS_ROOT

router = APIRouter(prefix="/api")

DICT_GITHUB = "atlas-github"
STATE_TTL_S = 600


# --- hooks (monkeypatched in tests) -----------------------------------------

def _default_exchange(code: str) -> str:
    import httpx
    r = httpx.post("https://github.com/login/oauth/access_token",
                   data={"client_id": os.environ["GITHUB_CLIENT_ID"],
                         "client_secret": os.environ["GITHUB_CLIENT_SECRET"],
                         "code": code},
                   headers={"Accept": "application/json"}, timeout=10)
    r.raise_for_status()
    token = r.json().get("access_token")
    if not token:
        raise HTTPException(502, "GitHub did not return a token")
    return token


def _default_gh_get(path: str, token: str | None):
    import httpx
    headers = {"Accept": "application/vnd.github+json"}
    if token:  # unauthenticated works for public repos (60 req/h)
        headers["Authorization"] = f"Bearer {token}"
    r = httpx.get(f"https://api.github.com{path}", headers=headers,
                  timeout=10)
    r.raise_for_status()
    return r.json()


exchange_code = _default_exchange
gh_get = _default_gh_get
store = None  # tests set a plain dict; production lazily opens the Modal Dict


def _store():
    if store is not None:
        return store
    import modal
    return modal.Dict.from_name(DICT_GITHUB, create_if_missing=True)


def _get(s, key, default=None):
    try:
        return s[key]
    except KeyError:
        return default


def current_token():
    """The operator's token, or None. Other modules may import this."""
    try:
        return _get(_store(), "token")
    except Exception:
        return None


def github_branch_facts(name: str) -> list[dict] | None:
    """Live branches enriched with open PR metadata when OAuth is connected.

    None means no usable OAuth connection, allowing callers to retain their
    stored branch fallback. An empty list is a valid live GitHub response.
    """
    token = current_token()
    if not token:
        return None
    try:
        branches = gh_get(f"/repos/{name}/branches?per_page=100", token)
        pulls = gh_get(f"/repos/{name}/pulls?state=open&per_page=100", token)
    except Exception:
        return None
    pull_by_head = {}
    for pull in pulls or []:
        head = (pull.get("head") or {}).get("ref")
        if not head or head in pull_by_head:
            continue
        pull_by_head[head] = {
            "number": pull.get("number"),
            "title": pull.get("title") or "",
            "url": pull.get("html_url") or "",
            "claim": (pull.get("body") or pull.get("title") or "")[:4000],
        }
    out = []
    for branch in branches or []:
        branch_name = branch.get("name")
        sha = (branch.get("commit") or {}).get("sha")
        if branch_name and sha:
            out.append({"name": branch_name, "sha": sha,
                        "pr": pull_by_head.get(branch_name),
                        "source": "github"})
    return out


# --- auth routes ------------------------------------------------------------

def _frontend() -> str:
    return os.environ.get("ATLAS_FRONTEND_URL", "http://localhost:3000")


@router.get("/auth/github/login")
def login():
    cid = os.environ.get("GITHUB_CLIENT_ID")
    if not cid:
        raise HTTPException(503, "GitHub OAuth not configured: create the "
                                 "github-oauth Modal secret and redeploy")
    state = pysecrets.token_urlsafe(16)
    _store()["state"] = {"v": state, "t": time.time()}
    return RedirectResponse(
        "https://github.com/login/oauth/authorize"
        f"?client_id={cid}&scope=repo&state={state}")


@router.get("/auth/github/callback")
def callback(code: str = "", state: str = ""):
    s = _store()
    saved = _get(s, "state") or {}
    if not code or not state or state != saved.get("v") \
            or time.time() - saved.get("t", 0) > STATE_TTL_S:
        raise HTTPException(400, "bad or expired oauth state")
    token = exchange_code(code)
    login_name = (gh_get("/user", token) or {}).get("login")
    s["token"] = token
    s["login"] = login_name
    s["connected_at"] = time.time()
    return RedirectResponse(f"{_frontend()}/?github=connected")


@router.get("/auth/github/status")
def status():
    s = _store()
    tok = _get(s, "token")
    return {"connected": bool(tok), "login": _get(s, "login")}


@router.post("/auth/github/disconnect")
def disconnect():
    s = _store()
    for k in ("token", "login", "connected_at"):
        try:
            del s[k]
        except KeyError:
            pass
    return {"connected": False}


# --- repo picker + connect --------------------------------------------------

@router.get("/github/repos")
def github_repos():
    tok = current_token()
    if not tok:
        raise HTTPException(401, "GitHub not connected")
    rows = gh_get("/user/repos?sort=pushed&per_page=30", tok)
    return [{"name": r["full_name"], "private": r["private"],
             "default_branch": r.get("default_branch"),
             "pushed_at": r.get("pushed_at")} for r in rows]


@router.post("/repos")
def connect_repo(body: dict):
    """Connect a repo: writes an entry into repos.d/ on the runs volume;
    api.py and sessions.py merge repos.d into the repos list."""
    name = (body.get("name") or "").strip()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", name):
        raise HTTPException(422, "name must be owner/repo")
    default_branch = body.get("default_branch") or "main"
    try:  # token or not — public repos resolve unauthenticated
        default_branch = gh_get(f"/repos/{name}", current_token()).get(
            "default_branch", default_branch)
    except Exception:
        pass  # connect still succeeds; branch facts can be fixed later
    entry = {"name": name, "url": f"https://github.com/{name}",
             "description": "", "gpu": "A10G", "image": "atlas-torch-2.8.0",
             "correctness": "token_ids_match", "overrides": [],
             "approvals": "auto", "default_branch": default_branch,
             "evals": [], "branches": []}
    runs_root = os.environ.get(ENV_RUNS_ROOT, "/runs")
    root = os.path.join(runs_root, "repos.d")
    os.makedirs(root, exist_ok=True)
    filename = name.replace("/", "__") + ".json"
    path = os.path.join(root, filename)
    with open(path, "w") as f:
        json.dump(entry, f)
    removed_path = os.path.join(runs_root, "repos.removed", filename)
    if os.path.isfile(removed_path):
        os.remove(removed_path)
    try:
        import modal
        from atlas.contracts.names import VOLUME_RUNS
        modal.Volume.from_name(VOLUME_RUNS).commit()
    except Exception:
        pass
    return entry


@router.delete("/repos")
def remove_repo(name: str):
    """Hide a connected or seeded repo without deleting its historical runs.

    A tombstone suppresses bundled repos as well as repos.d entries. Connecting
    the same repo again clears the tombstone and restores it.
    """
    name = name.strip()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", name):
        raise HTTPException(422, "name must be owner/repo")
    runs_root = os.environ.get(ENV_RUNS_ROOT, "/runs")
    filename = name.replace("/", "__") + ".json"
    connected_path = os.path.join(runs_root, "repos.d", filename)
    if os.path.isfile(connected_path):
        os.remove(connected_path)
    removed_root = os.path.join(runs_root, "repos.removed")
    os.makedirs(removed_root, exist_ok=True)
    with open(os.path.join(removed_root, filename), "w") as f:
        json.dump({"name": name}, f)
    try:
        import modal
        from atlas.contracts.names import VOLUME_RUNS
        modal.Volume.from_name(VOLUME_RUNS).commit()
    except Exception:
        pass
    return {"ok": True, "name": name}
