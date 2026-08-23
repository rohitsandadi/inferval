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


def _default_gh_get(path: str, token: str):
    import httpx
    r = httpx.get(f"https://api.github.com{path}",
                  headers={"Authorization": f"Bearer {token}",
                           "Accept": "application/vnd.github+json"},
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
    tok = current_token()
    if tok:
        try:
            default_branch = gh_get(f"/repos/{name}", tok).get(
                "default_branch", default_branch)
        except Exception:
            pass  # connect still succeeds; branch facts can be fixed later
    entry = {"name": name, "url": f"https://github.com/{name}",
             "description": "", "gpu": "A10G", "image": "atlas-torch-2.8.0",
             "correctness": "token_ids_match", "overrides": [],
             "approvals": "manual", "default_branch": default_branch,
             "evals": [], "branches": []}
    root = os.path.join(os.environ.get(ENV_RUNS_ROOT, "/runs"), "repos.d")
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, name.replace("/", "__") + ".json")
    with open(path, "w") as f:
        json.dump(entry, f)
    try:
        import modal
        from atlas.contracts.names import VOLUME_RUNS
        modal.Volume.from_name(VOLUME_RUNS).commit()
    except Exception:
        pass
    return entry
