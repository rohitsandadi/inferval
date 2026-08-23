"""Eval store routes: create/list/delete, suite overlay, empty-suite guard."""
import pytest
from fastapi.testclient import TestClient

from atlas.api import api

REPO = "rohitsandadi/nanoGPT"
GOOD = {"name": "kv_cache_long", "cmd": "python bench.py --tokens 512 --out {out}",
        "checks": {"tokens_per_s": "-10%"}, "absolute": {"latency_ms_p95": "<3000"}}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ATLAS_RUNS_ROOT", str(tmp_path / "runs"))
    return TestClient(api.web_app)


def test_create_list_delete_roundtrip(client):
    assert client.get(f"/api/repos/{REPO}/evals").json() == []
    r = client.post(f"/api/repos/{REPO}/evals", json=GOOD)
    assert r.status_code == 200 and r.json()["name"] == "kv_cache_long"
    assert [e["name"] for e in client.get(f"/api/repos/{REPO}/evals").json()] \
        == ["kv_cache_long"]
    assert client.delete(f"/api/repos/{REPO}/evals/kv_cache_long").status_code == 200
    assert client.get(f"/api/repos/{REPO}/evals").json() == []
    assert client.delete(f"/api/repos/{REPO}/evals/kv_cache_long").status_code == 404


def test_validation(client):
    bad = [dict(GOOD, name="Bad Name"),
           dict(GOOD, cmd="no out placeholder"),
           dict(GOOD, checks={"made_up": "-10%"}),
           dict(GOOD, checks={"tokens_per_s": "10"}),
           dict(GOOD, checks={}, absolute={}),
           dict(GOOD, absolute={"latency_ms_p95": "3000"})]
    for body in bad:
        assert client.post(f"/api/repos/{REPO}/evals", json=body).status_code == 422, body
    assert client.post("/api/repos/ghost/repo/evals", json=GOOD).status_code == 404


def test_store_evals_join_the_repo_suite_and_runs(client, monkeypatch):
    client.post(f"/api/repos/{REPO}/evals", json=GOOD)
    repo = next(r for r in client.get("/api/repos").json() if r["name"] == REPO)
    assert "kv_cache_long" in repo["evals"]  # names in the listing

    captured = {}
    monkeypatch.setattr(api, "spawn_controller",
                        lambda spec: captured.update(spec=spec))
    r = client.post("/api/runs", json={
        "repo": REPO, "mode": "compare", "base_sha": "a", "head_sha": "b",
        "selection": "pick", "evals": ["kv_cache_long"]})
    assert r.status_code == 200
    assert [e["name"] for e in captured["spec"]["evals"]] == ["kv_cache_long"]


def test_store_eval_overrides_seeded_eval_by_name(client):
    client.post(f"/api/repos/{REPO}/evals", json=dict(
        GOOD, name="generate_short", checks={"tokens_per_s": "-5%"}))
    repo = next(r for r in client.get("/api/repos").json() if r["name"] == REPO)
    assert repo["evals"].count("generate_short") == 1


def test_empty_suite_run_rejected(client, monkeypatch):
    monkeypatch.setattr(api, "spawn_controller", lambda spec: None)
    # acme placeholders keep seeded evals; connect a fresh repo with none
    monkeypatch.setattr("atlas.api.github_auth.store", {})
    client.post("/api/repos", json={"name": "someone/bare-repo"})
    r = client.post("/api/runs", json={
        "repo": "someone/bare-repo", "mode": "check", "base_sha": "main"})
    assert r.status_code == 422
    assert "no evals defined" in r.json()["detail"]
