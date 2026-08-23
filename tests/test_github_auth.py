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
    def fake_gh_get(path, tok):
        if path == "/user":
            return {"login": "rohitsandadi"}
        if path.endswith("/branches?per_page=100"):
            return [
                {"name": "master", "commit": {"sha": "base-sha"}},
                {"name": "feature/live", "commit": {"sha": "head-sha"}},
                {"name": "experiment", "commit": {"sha": "exp-sha"}},
            ]
        if path.endswith("/pulls?state=open&per_page=100"):
            return [{"number": 42, "title": "Make it faster",
                     "html_url": "https://github.com/acme/new-model/pull/42",
                     "body": "Cuts inference latency in half.",
                     "head": {"ref": "feature/live"},
                     "base": {"ref": "master"}}]
        if path.startswith("/repos/"):
            return {"default_branch": "master"}
        return [{"full_name": "rohitsandadi/nanoGPT", "private": False,
                 "default_branch": "master",
                 "pushed_at": "2026-08-23T00:00:00Z"}]

    monkeypatch.setattr(github_auth, "gh_get", fake_gh_get)
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


def test_oauth_branches_and_prs_feed_review_picker(gh):
    github_auth.store["token"] = "t"
    assert gh.post("/api/repos", json={"name": "acme/new-model"}).status_code == 200
    rows = gh.get("/api/repos/acme/new-model/branches").json()
    by_name = {row["name"]: row for row in rows}
    assert set(by_name) == {"feature/live", "experiment"}
    assert by_name["feature/live"]["source"] == "github"
    assert by_name["feature/live"]["sha"] == "head-sha"
    assert by_name["feature/live"]["pr"]["number"] == 42
    assert by_name["feature/live"]["pr"]["claim"] == \
        "Cuts inference latency in half."
    assert by_name["experiment"]["pr"] is None


def test_remove_repo_persists_and_reconnect_restores(gh, tmp_path):
    seeded = "rohitsandadi/nanoGPT"
    dynamic = "acme/new-model"
    assert gh.post("/api/repos", json={"name": dynamic}).status_code == 200

    assert gh.delete("/api/repos", params={"name": dynamic}).json() == {
        "ok": True, "name": dynamic,
    }
    names = [repo["name"] for repo in gh.get("/api/repos").json()]
    assert dynamic not in names
    assert not (tmp_path / "runs" / "repos.d" /
                "acme__new-model.json").exists()

    assert gh.delete("/api/repos", params={"name": seeded}).status_code == 200
    names = [repo["name"] for repo in gh.get("/api/repos").json()]
    assert seeded not in names
    assert gh.get(f"/api/repos/{seeded}/evals").status_code == 404

    assert gh.post("/api/repos", json={"name": seeded}).status_code == 200
    names = [repo["name"] for repo in gh.get("/api/repos").json()]
    assert seeded in names
    assert not (tmp_path / "runs" / "repos.removed" /
                "rohitsandadi__nanoGPT.json").exists()
