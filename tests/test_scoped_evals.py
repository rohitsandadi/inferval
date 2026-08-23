"""The scoped-eval chain: shared validation contract, submit_review carrying
a draft, create_run accepting extra_evals (the zero-eval-repo path), the
planner keeping scoped evals, and the Review-this-PR trigger route."""
import json

import pytest
from fastapi.testclient import TestClient

from atlas.api import api, sessions
from atlas.contracts.evalspec import validate_eval, validate_scoped
from atlas.controller.controller import plan_evals
from atlas.session import tools as stools
from atlas.session.tools import SessionContext

REPO = "rohitsandadi/nanoGPT"
HARNESS_CMD = ("python /harness/bench.py --src {src} --eval kv_probe "
               "--tokens 256 --batch 2 --repeats 3 --out {out}")
SUITE = [{"name": "generate_short",
          "cmd": "python /harness/bench.py --src {src} --eval generate_short "
                 "--tokens 128 --batch 2 --repeats 5 --out {out}",
          "checks": {"tokens_per_s": "-10%"}}]


@pytest.fixture
def runs_root(tmp_path, monkeypatch):
    root = tmp_path / "runs"
    monkeypatch.setenv("ATLAS_RUNS_ROOT", str(root))
    return root


@pytest.fixture
def client(runs_root):
    return TestClient(api.web_app)


# --- the contract ------------------------------------------------------------

def test_validate_scoped_accepts_harness_parameterization():
    entry = validate_eval({"name": "kv_probe", "cmd": HARNESS_CMD,
                           "checks": {"tokens_per_s": "-10%"}})
    validate_scoped(entry, SUITE)          # declared harness
    validate_scoped(entry, [])             # zero-eval repo: platform harness


def test_validate_scoped_rejections():
    def scoped(cmd):
        return validate_scoped({"name": "x", "cmd": cmd, "checks": {}}, SUITE)
    with pytest.raises(ValueError, match="declared harness"):
        scoped("python steal_weights.py --src {src} --out {out}")
    with pytest.raises(ValueError, match="not allowed"):
        scoped("python /harness/bench.py --src {src} --out {out} --exec rm")
    with pytest.raises(ValueError, match="outside 1..512"):
        scoped("python /harness/bench.py --src {src} --tokens 1024 --out {out}")
    with pytest.raises(ValueError, match="outside 1..7"):
        scoped("python /harness/bench.py --src {src} --repeats 50 --out {out}")
    with pytest.raises(ValueError, match=r"\{src\}"):
        scoped("python /harness/bench.py --tokens 64 --out {out}")


# --- submit_review carries the draft ----------------------------------------

@pytest.fixture
def ctx(runs_root):
    cid = "c_scoped01"
    (runs_root / "chats" / cid).mkdir(parents=True)
    return SessionContext(chat_id=cid, runs_root=str(runs_root),
                          repo={"name": REPO, "evals": list(SUITE),
                                "overrides": []},
                          meta={"pr": {"number": 4, "title": "Faster KV"},
                                "branch": "opt-kv"})


def test_submit_review_includes_draft(ctx, runs_root):
    d = runs_root / "chats" / ctx.chat_id
    (d / "drafts.json").write_text(json.dumps(
        [{"id": "d1", "origin": "a1", "name": "kv_probe", "cmd": HARNESS_CMD,
          "checks": {"tokens_per_s": "-10%"}, "est_gpu_seconds": 30,
          "status": "proposed"}]))
    posted = []
    ctx.post_run = lambda payload: posted.append(payload) or "r_scoped01"

    assert "unknown draft" in stools.submit_review(ctx, "a", "b",
                                                   include_draft="d9")
    out = stools.submit_review(ctx, "a", "b", include_draft="d1")
    assert "r_scoped01" in out and "kv_probe" in out
    extra = posted[0]["extra_evals"][0]
    assert extra["name"] == "kv_probe" and extra["origin"] == "pr:4"
    drafts = json.loads((d / "drafts.json").read_text())
    assert drafts[0]["status"] == "submitted" and drafts[0]["run"] == "r_scoped01"


def test_submit_review_rejects_invalid_draft(ctx, runs_root):
    d = runs_root / "chats" / ctx.chat_id
    (d / "drafts.json").write_text(json.dumps(
        [{"id": "d1", "origin": "a1", "name": "kv_probe",
          "cmd": "python own_thing.py --out {out}", "checks": {},
          "est_gpu_seconds": 30, "status": "proposed"}]))
    ctx.post_run = lambda payload: "r_never"
    assert "no longer valid" in stools.submit_review(ctx, "a", "b",
                                                     include_draft="d1")
    assert ctx.reviews_submitted == 0


# --- create_run extra_evals --------------------------------------------------

def _spawn_capture(monkeypatch):
    captured = {}
    monkeypatch.setattr(api, "spawn_controller",
                        lambda spec: captured.update(spec=spec))
    return captured


def test_create_run_scoped_extra_on_zero_eval_repo(client, monkeypatch):
    captured = _spawn_capture(monkeypatch)
    monkeypatch.setattr("atlas.api.github_auth.store", {})
    client.post("/api/repos", json={"name": "someone/bare-repo"})
    body = {"repo": "someone/bare-repo", "mode": "compare",
            "base_sha": "a", "head_sha": "b",
            "extra_evals": [{"name": "kv_probe", "cmd": HARNESS_CMD,
                             "checks": {"tokens_per_s": "-10%"},
                             "origin": "pr:4"}]}
    r = client.post("/api/runs", json=body)
    assert r.status_code == 200, r.text
    evs = captured["spec"]["evals"]
    assert [e["name"] for e in evs] == ["kv_probe"]
    assert evs[0]["scoped"] is True and evs[0]["origin"] == "pr:4"


def test_create_run_extra_evals_validation(client, monkeypatch):
    _spawn_capture(monkeypatch)
    base = {"repo": REPO, "mode": "compare", "base_sha": "a", "head_sha": "b"}
    bad_cmd = dict(base, extra_evals=[{
        "name": "kv_probe", "cmd": "python x.py --out {out} --src {src}",
        "checks": {"tokens_per_s": "-10%"}}])
    r = client.post("/api/runs", json=bad_cmd)
    assert r.status_code == 422 and "declared harness" in r.json()["detail"]
    collide = dict(base, extra_evals=[{
        "name": "generate_short", "cmd": HARNESS_CMD,
        "checks": {"tokens_per_s": "-10%"}}])
    assert "collides" in client.post("/api/runs", json=collide).json()["detail"]
    extra = {"name": "kv_probe", "cmd": HARNESS_CMD,
             "checks": {"tokens_per_s": "-10%"}}
    over = dict(base, extra_evals=[dict(extra, name=f"kv_probe_{i}")
                                   for i in range(3)])
    assert "at most 2" in client.post("/api/runs", json=over).json()["detail"]


# --- planner keeps scoped evals ---------------------------------------------

def test_planner_never_drops_scoped(monkeypatch):
    spec = {"evals": [{"name": "generate_short"},
                      {"name": "kv_probe", "scoped": True}]}
    monkeypatch.setattr("atlas.investigator.loop.plan",
                        lambda s, d: {"evals": ["generate_short"],
                                      "reasoning": "short covers it"})
    chosen = plan_evals(spec, lambda *a, **k: None)
    assert [e["name"] for e in chosen] == ["generate_short", "kv_probe"]


# --- the trigger route -------------------------------------------------------

def test_review_pr_route_spawns_directive_worker(client, monkeypatch, runs_root):
    def fake_fetch(repo, number, cache_dir):
        return {"number": number, "title": "t", "url": "u", "body": "b",
                "head": "h", "base": "b0", "head_ref": "branch-x"}
    spawned = []
    monkeypatch.setattr(sessions, "fetch_pr", fake_fetch)
    monkeypatch.setattr(sessions, "spawn_turn",
                        lambda cid, text, directive=False:
                        spawned.append((cid, text, directive)))
    r = client.post(f"/api/repos/{REPO}/prs/4/review")
    assert r.status_code == 200
    cid = r.json()["session"]
    assert spawned == [(cid, "", True)]
    meta = json.loads((runs_root / "chats" / cid / "meta.json").read_text())
    assert meta["pr"]["number"] == 4 and meta["branch"] == "branch-x"


def test_review_pr_route_unknown_repo(client):
    assert client.post("/api/repos/ghost/repo/prs/1/review").status_code == 404


def test_review_session_route(client, monkeypatch, runs_root):
    def fake_fetch(repo, number, cache_dir):
        return {"number": number, "title": "t", "url": "u", "body": "b",
                "head": "h", "base": "b0", "head_ref": "branch-x"}
    monkeypatch.setattr(sessions, "fetch_pr", fake_fetch)
    cid = client.post(f"/api/repos/{REPO}/sessions",
                      json={"pr": 4}).json()["session"]
    spawned = []
    monkeypatch.setattr(sessions, "spawn_turn",
                        lambda c, text, directive=False:
                        spawned.append((c, directive)))
    assert client.post(f"/api/sessions/{cid}/review").status_code == 200
    assert spawned == [(cid, True)]
    assert client.post("/api/sessions/c_ghost/review").status_code == 404
