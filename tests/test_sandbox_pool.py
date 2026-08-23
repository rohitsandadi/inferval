"""Warm-pool tests: pure sweep/reuse decisions, plus controller park/reuse
sequencing against an in-memory registry. No Modal, no network."""
import time

import pytest

from atlas.contracts.names import ENV_RUNS_ROOT
from atlas.controller import controller
from atlas.runner import paired_runner, sandbox_mgr

SPEC = {"schema": "1", "run": "t_pool", "mode": "compare", "repo": "x",
        "base_sha": "aaaa", "head_sha": "bbbb", "gpu": "A10G", "image": "img",
        "selection": "all", "approvals": "auto",
        "evals": [{"name": "gen", "cmd": "python /harness/bench.py "
                   "--tokens 128 --batch 2 --repeats 5 --out {out}",
                   "checks": {"tokens_per_s": "-10%"}}]}


def block(label, i, tps):
    return {"schema": "1", "status": "completed", "label": label, "block": i,
            "eval": "gen", "params": {},
            "samples": {"tokens_per_s": [tps]},
            "summary": {"tokens_per_s": tps, "latency_ms_median": 1.0,
                        "latency_ms_p95": 1.0, "peak_vram_mb": 1.0},
            "output_ids": [[1, 2]], "outputs_consistent": True,
            "timing": "cuda_sync_wall", "env": {}}


class FakeSandbox:
    def __init__(self, object_id="sb-new", alive=True):
        self.object_id = object_id
        self.alive = alive
        self.terminated = False

    def poll(self):
        return None if self.alive else 137  # Modal: None = still running

    def terminate(self):
        self.terminated = True
        self.alive = False


# --- pure decisions ---------------------------------------------------------

def test_sweep_pool_only_expired_cooldown():
    entries = {"sb-old": {"state": "cooldown", "deadline": 100},
               "sb-live": {"state": "cooldown", "deadline": 900},
               "sb-run": {"state": "running", "deadline": 100},
               "sb-dead": {"state": "terminated", "deadline": 100},
               "sb-junk": "not-a-dict"}
    assert controller.sweep_pool(entries, now=500) == ["sb-old"]
    assert controller.sweep_pool({}, now=500) == []


def test_reuse_candidate_matches_repo_gpu_and_deadline():
    entries = {
        "sb-a": {"state": "cooldown", "deadline": 900, "repo": "x", "gpu": "A10G"},
        "sb-b": {"state": "cooldown", "deadline": 900, "repo": "y", "gpu": "A10G"},
        "sb-c": {"state": "cooldown", "deadline": 100, "repo": "x", "gpu": "A10G"},
        "sb-d": {"state": "running", "deadline": 900, "repo": "x", "gpu": "A10G"},
    }
    assert controller.reuse_candidate(entries, "x", "A10G", now=500) == "sb-a"
    assert controller.reuse_candidate(entries, "x", "H100", now=500) is None
    assert controller.reuse_candidate(entries, "z", "A10G", now=500) is None
    assert controller.reuse_candidate({}, "x", "A10G", now=500) is None


# --- controller sequencing over a fake registry -----------------------------

@pytest.fixture
def pool_wired(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_RUNS_ROOT, str(tmp_path))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    state = {"pool": {}, "created": [], "from_id": {}, "dests": []}
    monkeypatch.setattr(
        sandbox_mgr, "create_sandbox",
        lambda run_id, gpu, image:
        state["created"].append(run_id) or FakeSandbox("sb-new"))
    monkeypatch.setattr(sandbox_mgr, "ready_check", lambda sb: "FAKE GPU")
    monkeypatch.setattr(controller.revisions, "materialize",
                        lambda sb, repo, sha, dest:
                        state["dests"].append(dest) or sha)
    monkeypatch.setattr(paired_runner, "preflight",
                        lambda sb, spec, volume=None:
                        [block("base", 0, 1.0), block("head", 1, 1.0)])
    monkeypatch.setattr(
        paired_runner, "run_blocks",
        lambda sb, spec, ev, overrides=None, volume=None, on_block=None, **kw:
        [block("base", 0, 400.0), block("head", 1, 401.0),
         block("head", 2, 401.0), block("base", 3, 400.0)])
    monkeypatch.setattr(controller, "_pool_dict", lambda: state["pool"])
    monkeypatch.setattr(controller, "_sandbox_from_id",
                        lambda sid: state["from_id"][sid])
    return tmp_path, state


def kinds(tmp_path, run_id):
    import json
    with open(tmp_path / run_id / "events.jsonl") as f:
        return [json.loads(l)["kind"] for l in f]


def test_completed_run_parks_with_fresh_clone_dirs(pool_wired):
    tmp_path, state = pool_wired
    controller.run(SPEC)
    e = state["pool"]["sb-new"]
    assert e["state"] == "cooldown"
    assert e["repo"] == "x" and e["gpu"] == "A10G"
    assert e["attached"] == {"run": "t_pool"}
    assert e["deadline"] >= int(time.time()) + controller.COOLDOWN_S - 5
    assert e["created_at"]
    ks = kinds(tmp_path, "t_pool")
    assert "sandbox_parked" in ks and "terminated" not in ks
    assert state["dests"] == ["/work/t_pool/base", "/work/t_pool/head"]


def test_failed_run_terminates_and_marks(pool_wired, monkeypatch):
    tmp_path, state = pool_wired
    monkeypatch.setattr(controller.revisions, "materialize",
                        lambda *a: (_ for _ in ()).throw(
                            RuntimeError("clone failed")))
    report = controller.run(SPEC)
    assert report["verdict"]["verdict"] == "invalid"
    assert state["pool"]["sb-new"]["state"] == "terminated"
    ks = kinds(tmp_path, "t_pool")
    assert "terminated" in ks and "sandbox_parked" not in ks


def test_sweep_terminates_expired_then_creates(pool_wired):
    tmp_path, state = pool_wired
    expired = FakeSandbox("sb-exp")
    state["from_id"]["sb-exp"] = expired
    state["pool"]["sb-exp"] = {"repo": "x", "gpu": "A10G", "state": "cooldown",
                               "deadline": int(time.time()) - 5,
                               "attached": {"run": "old"}, "created_at": "t0"}
    controller.run(SPEC)
    assert expired.terminated is True
    assert state["pool"]["sb-exp"]["state"] == "terminated"
    assert state["created"] == ["t_pool"]  # expired one was NOT reused
    assert "sandbox_up" in kinds(tmp_path, "t_pool")


def test_reuse_matching_warm_sandbox(pool_wired):
    tmp_path, state = pool_wired
    warm = FakeSandbox("sb-warm")
    state["from_id"]["sb-warm"] = warm
    state["pool"]["sb-warm"] = {"repo": "x", "gpu": "A10G", "state": "cooldown",
                                "deadline": int(time.time()) + 500,
                                "attached": {"run": "old"},
                                "created_at": "t0"}
    controller.run(SPEC)
    assert state["created"] == []  # no fresh sandbox
    ks = kinds(tmp_path, "t_pool")
    assert "sandbox_reused" in ks and "sandbox_up" not in ks
    e = state["pool"]["sb-warm"]
    assert e["state"] == "cooldown"  # parked again after the run
    assert e["attached"] == {"run": "t_pool"}
    assert e["created_at"] == "t0"  # original creation time preserved
    assert state["dests"] == ["/work/t_pool/base", "/work/t_pool/head"]


def test_reuse_skips_dead_sandbox(pool_wired):
    tmp_path, state = pool_wired
    dead = FakeSandbox("sb-dead", alive=False)
    state["from_id"]["sb-dead"] = dead
    state["pool"]["sb-dead"] = {"repo": "x", "gpu": "A10G", "state": "cooldown",
                                "deadline": int(time.time()) + 500,
                                "attached": None, "created_at": "t0"}
    controller.run(SPEC)
    assert state["pool"]["sb-dead"]["state"] == "terminated"
    assert state["created"] == ["t_pool"]  # fell through to a fresh sandbox
    ks = kinds(tmp_path, "t_pool")
    assert "sandbox_up" in ks and "sandbox_reused" not in ks


def test_pool_unavailable_never_blocks_a_run(pool_wired, monkeypatch):
    tmp_path, state = pool_wired
    monkeypatch.setattr(controller, "_pool_dict",
                        lambda: (_ for _ in ()).throw(
                            RuntimeError("dict down")))
    report = controller.run(SPEC)
    assert report["verdict"]["verdict"] == "pass"  # the run still completes
    ks = kinds(tmp_path, "t_pool")
    assert "sandbox_up" in ks
    # can't park without the registry -> terminated, never leaked
    assert "terminated" in ks and "sandbox_parked" not in ks
