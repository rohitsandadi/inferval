"""Single-user GitHub OAuth routes: hooks mocked, no network/Modal."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from atlas.api import api, github_auth


@pytest.fixture
def gh(tmp_path, monkeypatch):
    monkeypatch.setenv("ATLAS_RUNS_ROOT", str(tmp_path / "runs"))
    monkeypatch.setenv("GITHUB_CLIENT_ID", "cid123")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "sec456")
    monkeypatch.setattr(github_auth, "store", {})
    monkeypatch.setattr(github_auth, "exchange_code", lambda code: "tok_" + code)
    monkeypatch.setattr(github_auth, "gh_get", lambda path, tok: (
        {"login": "rohitsandadi"} if path == "/user"
        else {"default_branch": "master"} if path.startswith("/repos/")
        else [{"full_name": "rohitsandadi/nanoGPT", "private": False,
               "default_branch": "master", "pushed_at": "2026-08-23T00:00:00Z"}]))
    return TestClient(api.web_app, follow_redirects=False)


def test_login_redirects_with_state(gh):
    r = gh.get("/api/auth/github/login")
    assert r.status_code in (302, 307)
    assert "client_id=cid123" in r.headers["location"]
    assert github_auth.store["state"]["v"] in r.headers["location"]


def test_login_503_without_config(gh, monkeypatch):
    monkeypatch.delenv("GITHUB_CLIENT_ID")
    assert gh.get("/api/auth/github/login").status_code == 503


def test_callback_roundtrip_and_status(gh):
    gh.get("/api/auth/github/login")
    state = github_auth.store["state"]["v"]
    r = gh.get(f"/api/auth/github/callback?code=abc&state={state}")
    assert r.status_code in (302, 307)
    assert r.headers["location"].endswith("/?github=connected")
    assert github_auth.store["token"] == "tok_abc"
    s = gh.get("/api/auth/github/status").json()
    assert s == {"connected": True, "login": "rohitsandadi"}
    gh.post("/api/auth/github/disconnect")
    assert gh.get("/api/auth/github/status").json()["connected"] is False


def test_callback_rejects_bad_or_stale_state(gh):
    gh.get("/api/auth/github/login")
    assert gh.get("/api/auth/github/callback?code=x&state=wrong").status_code == 400
    github_auth.store["state"]["t"] = time.time() - 9999
    good = github_auth.store["state"]["v"]
    assert gh.get(f"/api/auth/github/callback?code=x&state={good}").status_code == 400


def test_repo_picker_requires_connection(gh):
    assert gh.get("/api/github/repos").status_code == 401
    github_auth.store["token"] = "t"
    rows = gh.get("/api/github/repos").json()
    assert rows[0]["name"] == "rohitsandadi/nanoGPT"


def test_connect_repo_writes_and_merges(gh, tmp_path):
    github_auth.store["token"] = "t"
    r = gh.post("/api/repos", json={"name": "acme/new-model"})
    assert r.status_code == 200
    assert r.json()["default_branch"] == "master"  # fetched via gh_get
    written = json.loads((tmp_path / "runs" / "repos.d" /
                          "acme__new-model.json").read_text())
    assert written["name"] == "acme/new-model"
    names = [x["name"] for x in gh.get("/api/repos").json()]
    assert "acme/new-model" in names
    assert gh.post("/api/repos", json={"name": "not-a-repo"}).status_code == 422
