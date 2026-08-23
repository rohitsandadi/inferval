"""M4 API tests: TestClient over fake run dirs built from atlas/fixtures.
No network, no Modal — both Modal hooks are monkeypatched."""
import json
import os
import pathlib
import shutil

import pytest
from fastapi.testclient import TestClient

from atlas.api import api
from atlas.contracts.validate import validate

FIX = pathlib.Path(__file__).resolve().parent.parent / "atlas" / "fixtures"

SPEC_FIX01 = {"schema": "1", "run": "r_fix01", "mode": "compare",
              "repo": "rohitsandadi/nanoGPT", "base_sha": "3adf61e1",
              "head_sha": "9c2b11d0", "gpu": "A10G",
              "image": "atlas-torch-2.8.0", "evals": [], "selection": "auto",
              "claim": "~2x faster generation", "approvals": "manual"}


@pytest.fixture
def runs_root(tmp_path, monkeypatch):
    root = tmp_path / "runs"

    # r_fix01: completed regression run, assembled from the fixtures.
    d = root / "r_fix01"
    (d / "experiments" / "e1").mkdir(parents=True)
    (d / "spec.json").write_text(json.dumps(SPEC_FIX01))
    shutil.copy(FIX / "events_regression.jsonl", d / "events.jsonl")
    shutil.copy(FIX / "verdict_regression.json", d / "verdict.json")
    shutil.copy(FIX / "investigation_regression.json", d / "investigation.json")
    verdict = json.loads((FIX / "verdict_regression.json").read_text())
    (d / "report.json").write_text(json.dumps(
        {"schema": "1", "run": "r_fix01", "verdict": verdict,
         "summary": ["tokens/sec fell 33% on generate_short"], "flagged": [],
         "pr_comment_md": "## Atlas verdict: regression"}))
    (d / "experiments" / "e1" / "b1_head.json").write_text(
        json.dumps({"summary": {"tokens_per_s": 318.9}}))
    (d / "big.txt").write_bytes(b"x" * (300 * 1024))
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    os.symlink(outside, d / "leak.txt")

    # r_run02: bare running run — three complete events (newer than r_fix01)
    # plus a partially-written trailing line.
    d2 = root / "r_run02"
    d2.mkdir()
    (d2 / "spec.json").write_text(json.dumps(
        dict(SPEC_FIX01, run="r_run02", head_sha="deadbeef")))
    head = (FIX / "events_regression.jsonl").read_text().splitlines()[:3]
    body = "\n".join(h.replace("r_fix01", "r_run02").replace("T13:", "T14:")
                     for h in head) + "\n"
    (d2 / "events.jsonl").write_text(body + '{"t": "2026-08-23T14:0')

    monkeypatch.setenv("ATLAS_RUNS_ROOT", str(root))
    return root


@pytest.fixture
def client(runs_root):
    return TestClient(api.web_app)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_repos_merge(client):
    repos = {r["name"]: r for r in client.get("/api/repos").json()}
    nano = repos["rohitsandadi/nanoGPT"]
    assert nano["runs_count"] == 2
    assert nano["last_run"]["run"] == "r_run02"    # newest run, no verdict yet
    assert nano["last_run"]["verdict"] is None
    assert nano["evals"] == ["generate_short", "generate_long"]
    assert repos["acme/whisper-stream"]["runs_count"] == 0
    assert repos["acme/whisper-stream"]["last_run"] is None


def test_repo_runs_listing(client):
    runs = client.get("/api/repos/rohitsandadi/nanoGPT/runs").json()
    assert [r["run"] for r in runs] == ["r_run02", "r_fix01"]  # newest first
    fix = runs[1]
    assert fix["verdict"] == "regression"
    assert fix["status"] == "done"
    assert fix["mode"] == "compare"
    assert fix["base_sha"] == "3adf61e1" and fix["head_sha"] == "9c2b11d0"
    assert fix["tokens_per_s_delta_pct"] == -33.01
    assert fix["p95_delta_pct"] == 18.49
    assert fix["vram_delta_pct"] == 0.37
    assert abs(fix["duration_s"] - 521) < 1   # 13:00:00 -> 13:08:41
    assert fix["cost_usd"] == round(521 / 3600 * 1.10, 2)
    assert fix["created_at"].startswith("2026-08-23T13:00:00")
    live = runs[0]
    assert live["verdict"] is None
    assert live["status"] == "provisioning"


def test_run_detail(client):
    r = client.get("/api/runs/r_fix01")
    assert r.status_code == 200
    body = r.json()
    assert body["spec"]["run"] == "r_fix01"
    assert body["verdict"]["verdict"] == "regression"
    assert body["status"] == "done"
    assert body["cost_usd"] == round(521 / 3600 * 1.10, 2)
    assert client.get("/api/runs/nope").status_code == 404


def _lines(resp):
    return [json.loads(l) for l in resp.text.splitlines() if l.strip()]


def test_events_cursor(client):
    """JSONL body; the client's cursor = complete lines received so far."""
    r = client.get("/api/runs/r_run02/events?since=0")
    assert r.headers["content-type"].startswith("application/x-ndjson")
    b = _lines(r)
    assert len(b) == 3                        # partial tail not served
    assert b[0]["kind"] == "run_created"
    assert _lines(client.get("/api/runs/r_run02/events?since=3")) == []
    full = _lines(client.get("/api/runs/r_fix01/events?since=0"))
    assert len(full) == 21
    assert _lines(client.get("/api/runs/r_fix01/events?since=21")) == []


def test_report(client):
    r = client.get("/api/runs/r_fix01/report")
    assert r.status_code == 200
    assert r.json()["pr_comment_md"].startswith("## Atlas")
    r404 = client.get("/api/runs/r_run02/report")
    assert r404.status_code == 404 and "detail" in r404.json()


def test_artifact_serving(client):
    ok = client.get("/api/runs/r_fix01/artifact",
                    params={"path": "experiments/e1/b1_head.json"})
    assert ok.status_code == 200
    assert ok.headers["content-type"].startswith("application/json")
    assert ok.json()["summary"]["tokens_per_s"] == 318.9
    # traversal, absolute path, symlink escape
    assert client.get("/api/runs/r_fix01/artifact",
                      params={"path": "../r_run02/spec.json"}).status_code == 400
    assert client.get("/api/runs/r_fix01/artifact",
                      params={"path": "/etc/passwd"}).status_code == 400
    assert client.get("/api/runs/r_fix01/artifact",
                      params={"path": "leak.txt"}).status_code == 400
    assert client.get("/api/runs/r_fix01/artifact",
                      params={"path": "missing.txt"}).status_code == 404
    # size cap: 300KB file truncates to 256KB, served as text
    big = client.get("/api/runs/r_fix01/artifact", params={"path": "big.txt"})
    assert big.status_code == 200
    assert len(big.content) == 256 * 1024
    assert big.headers["content-type"].startswith("text/plain")


def test_post_run_composes_spec_and_spawns(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(api, "spawn_controller",
                        lambda spec: captured.update(spec=spec))
    r = client.post("/api/runs", json={
        "repo": "rohitsandadi/nanoGPT", "mode": "compare", "base_sha": "aaa",
        "head_sha": "bbb", "selection": "pick", "evals": ["generate_long"],
        "claim": "2x faster"})
    assert r.status_code == 200
    run_id = r.json()["run"]
    assert run_id.startswith("r_") and len(run_id) == 10
    spec = captured["spec"]
    validate(spec, "run_spec")
    assert spec["run"] == run_id
    assert [e["name"] for e in spec["evals"]] == ["generate_long"]
    assert spec["evals"][0]["checks"]["tokens_per_s"] == "-10%"
    assert spec["gpu"] == "A10G" and spec["image"] == "atlas-torch-2.8.0"
    assert spec["claim"] == "2x faster"
    assert spec["approvals"] == "auto"  # repo default from repos.json
    assert spec["repo"] == "https://github.com/rohitsandadi/nanoGPT"  # clonable
    assert spec["overrides"] == ["batch"]  # probe whitelist rides along


def test_post_run_validation(client, monkeypatch):
    monkeypatch.setattr(api, "spawn_controller", lambda spec: None)
    base = {"repo": "rohitsandadi/nanoGPT", "mode": "compare",
            "base_sha": "aaa", "head_sha": "bbb"}
    assert client.post("/api/runs", json=dict(
        base, selection="pick", evals=["nope"])).status_code == 422
    assert client.post("/api/runs", json=dict(
        base, selection="pick", evals=[])).status_code == 422
    assert client.post("/api/runs", json=dict(
        base, repo="ghost/repo")).status_code == 404
    assert client.post("/api/runs", json=dict(
        base, mode="race")).status_code == 422
    no_head = {k: v for k, v in base.items() if k != "head_sha"}
    assert client.post("/api/runs", json=no_head).status_code == 422
    assert client.post("/api/runs",
                       json=dict(no_head, mode="check")).status_code == 200


def test_post_run_spawn_failure_502(client, monkeypatch):
    def boom(spec):
        raise RuntimeError("modal down")
    monkeypatch.setattr(api, "spawn_controller", boom)
    r = client.post("/api/runs", json={
        "repo": "rohitsandadi/nanoGPT", "mode": "check", "base_sha": "aaa"})
    assert r.status_code == 502
    assert "modal down" in r.json()["detail"]


# --- branches endpoint (frozen seam, v2/UI_PLAN.md) -------------------------

BRANCH_SPEC = {"schema": "1", "mode": "compare",
               "repo": "https://github.com/rohitsandadi/nanoGPT",
               "base_sha": "atlas-base", "gpu": "A10G",
               "image": "atlas-torch-2.8.0", "evals": [], "selection": "auto",
               "approvals": "auto"}


def _branch_run(root, run_id, hm, kinds, verdict=None, **spec_extra):
    d = root / run_id
    d.mkdir(parents=True)
    (d / "spec.json").write_text(json.dumps(
        dict(BRANCH_SPEC, run=run_id, **spec_extra)))
    lines = [json.dumps({"t": f"2026-08-23T{hm}:00Z", "run": run_id,
                         "tier": "lifecycle", "kind": k, "detail": {}})
             for k in kinds]
    (d / "events.jsonl").write_text("\n".join(lines) + "\n")
    if verdict:
        (d / "verdict.json").write_text(json.dumps(verdict))


@pytest.fixture
def branch_client(tmp_path, monkeypatch):
    root = tmp_path / "runs"
    # keep the suite hermetic: the branches route prefers live GitHub branch
    # facts; None falls back to the repos.json fixtures these tests assert
    monkeypatch.setattr("atlas.api.github_auth.github_branch_facts",
                        lambda name: None)
    # opt-sampling: an old pass, then a newer regression — newest wins.
    _branch_run(root, "r_hero0", "15:00", ["submitted", "report_ready"],
                verdict={"verdict": "pass", "checks": []},
                branch="opt-sampling", head_sha="opt-sampling")
    _branch_run(root, "r_hero1", "15:10", ["submitted", "report_ready"],
                verdict={"verdict": "regression",
                         "checks": [{"eval": "generate_short",
                                     "metric": "tokens_per_s",
                                     "delta_pct": -33.01}]},
                branch="opt-sampling", head_sha="opt-sampling")
    # opt-allocation: no `branch` key — matched via head_sha == branch name.
    _branch_run(root, "r_pass", "15:20", ["submitted", "report_ready"],
                verdict={"verdict": "pass",
                         "checks": [{"eval": "generate_short",
                                     "metric": "tokens_per_s",
                                     "delta_pct": 3.47}]},
                head_sha="opt-allocation")
    # fix-sampling: verdict written but run not done → running, verdict null.
    _branch_run(root, "r_live", "15:30", ["submitted", "verdict"],
                verdict={"verdict": "pass", "checks": []},
                branch="fix-sampling", head_sha="fix-sampling")
    # opt-allocation again but against another base — hidden by default.
    _branch_run(root, "r_oldbase", "15:40", ["submitted", "report_ready"],
                verdict={"verdict": "regression", "checks": []},
                branch="opt-allocation", head_sha="opt-allocation",
                base_sha="9755682")
    monkeypatch.setenv("ATLAS_RUNS_ROOT", str(root))
    return TestClient(api.web_app)


def test_branches_states_and_shape(branch_client):
    r = branch_client.get("/api/repos/rohitsandadi/nanoGPT/branches")
    assert r.status_code == 200
    by = {b["name"]: b for b in r.json()}
    assert set(by) == {"opt-sampling", "opt-allocation", "opt-layout",
                       "fix-sampling", "experiment/kv-cache"}

    hero = by["opt-sampling"]
    assert hero["state"] == "regression"
    assert hero["reviews_count"] == 2
    assert hero["last_review"]["run"] == "r_hero1"        # newest of the two
    assert hero["last_review"]["verdict"] == "regression"
    assert hero["last_review"]["tokens_per_s_delta_pct"] == -33.01
    assert hero["last_review"]["status"] == "done"
    assert hero["last_review"]["t"].startswith("2026-08-23T15:10")
    assert hero["pr"]["number"] == 1
    assert hero["pr"]["url"].endswith("/pull/1")
    assert "~2x faster generation" in hero["pr"]["claim"]

    ok = by["opt-allocation"]                # head_sha match, base filter kept
    assert ok["state"] == "verified"
    assert ok["reviews_count"] == 1          # r_oldbase excluded by base
    assert ok["last_review"]["run"] == "r_pass"
    assert ok["last_review"]["tokens_per_s_delta_pct"] == 3.47
    assert ok["pr"]["number"] == 2

    live = by["fix-sampling"]
    assert live["state"] == "running"
    assert live["reviews_count"] == 1
    assert live["last_review"]["verdict"] is None         # null while running
    assert live["last_review"]["status"] == "verdict"
    assert live["pr"] is None                             # plain branch

    idle = by["experiment/kv-cache"]
    assert idle["state"] == "unverified"
    assert idle["last_review"] is None
    assert idle["reviews_count"] == 0
    assert idle["pr"] is None
    assert idle["sha"] == "32a23271"


def test_branches_base_filter(branch_client):
    r = branch_client.get("/api/repos/rohitsandadi/nanoGPT/branches",
                          params={"base": "9755682"})
    by = {b["name"]: b for b in r.json()}
    assert by["opt-allocation"]["state"] == "regression"  # r_oldbase now counts
    assert by["opt-allocation"]["reviews_count"] == 1
    assert by["opt-allocation"]["last_review"]["run"] == "r_oldbase"
    assert by["opt-sampling"]["state"] == "unverified"    # atlas-base runs hidden
    assert by["opt-sampling"]["reviews_count"] == 0
    assert by["opt-sampling"]["last_review"] is None


def test_branches_unknown_repo_404(branch_client):
    r = branch_client.get("/api/repos/ghost/repo/branches")
    assert r.status_code == 404 and "detail" in r.json()


def test_branches_repo_without_branch_facts(branch_client):
    # repos.json declares no branches for this repo → empty list, not an error
    r = branch_client.get("/api/repos/acme/whisper-stream/branches")
    assert r.status_code == 200 and r.json() == []


def test_proposal_decision(client, runs_root, monkeypatch):
    calls = []
    monkeypatch.setattr(api, "set_approval",
                        lambda rid, pid, d: calls.append((rid, pid, d)))
    r = client.post("/api/runs/r_fix01/proposals/p9",
                    json={"decision": "approved"})
    assert r.status_code == 200
    assert calls == [("r_fix01", "p9", "approved")]
    last = json.loads((runs_root / "r_fix01" / "events.jsonl")
                      .read_text().splitlines()[-1])
    assert last["kind"] == "proposal_approved"
    assert last["tier"] == "human"
    assert last["detail"]["id"] == "p9"

    r2 = client.post("/api/runs/r_run02/proposals/p1",
                     json={"decision": "denied"})
    assert r2.status_code == 200
    assert calls[-1] == ("r_run02", "p1", "denied")
    # denial event appended after the partial line's file... the append goes
    # to the end; the partial tail stays untouched before it.
    text = (runs_root / "r_run02" / "events.jsonl").read_text()
    assert '"proposal_denied"' in text

    assert client.post("/api/runs/r_fix01/proposals/p9",
                       json={"decision": "maybe"}).status_code == 422
    assert client.post("/api/runs/ghost/proposals/p1",
                       json={"decision": "denied"}).status_code == 404
    assert len(calls) == 2  # rejected requests never reached the hooks
