"""M5 sequencing tests: monkeypatched runner, real referee, no Modal."""
import json

import pytest

from atlas.contracts.names import ENV_RUNS_ROOT
from atlas.controller import controller
from atlas.runner import paired_runner, sandbox_mgr

SPEC = {"schema": "1", "run": "t_ctl", "mode": "compare", "repo": "x",
        "base_sha": "aaaa", "head_sha": "bbbb", "gpu": "A10G", "image": "img",
        "selection": "all", "approvals": "auto", "claim": "faster",
        "evals": [{"name": "gen", "cmd": "python /harness/bench.py "
                   "--tokens 128 --batch 2 --repeats 5 --out {out}",
                   "checks": {"tokens_per_s": "-10%"}}]}


def block(label, i, tps, status="completed"):
    return {"schema": "1", "status": status, "label": label, "block": i,
            "eval": "gen", "params": {},
            "samples": {"tokens_per_s": [tps]},
            "summary": {"tokens_per_s": tps, "latency_ms_median": 1.0,
                        "latency_ms_p95": 1.0, "peak_vram_mb": 1.0},
            "output_ids": [[1, 2]], "outputs_consistent": True,
            "timing": "cuda_sync_wall", "env": {}}


class FakeSandbox:
    object_id = "sb-fake"


@pytest.fixture
def wired(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_RUNS_ROOT, str(tmp_path))
    # keep the investigator seam offline: no key -> plan/investigate raise
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    state = {"terminated": False, "pool": {}}
    monkeypatch.setattr(sandbox_mgr, "create_sandbox",
                        lambda run_id, gpu, image: FakeSandbox())
    monkeypatch.setattr(sandbox_mgr, "ready_check", lambda sb: "FAKE GPU")
    monkeypatch.setattr(controller.revisions, "materialize",
                        lambda sb, repo, sha, dest: sha)
    monkeypatch.setattr(paired_runner, "preflight",
                        lambda sb, spec, volume=None:
                        [block("base", 0, 1.0), block("head", 1, 1.0)])
    monkeypatch.setattr(
        sandbox_mgr, "terminate",
        lambda sb: state.__setitem__("terminated", True))
    # warm pool: an in-memory registry stands in for the Modal Dict
    monkeypatch.setattr(controller, "_pool_dict", lambda: state["pool"])
    monkeypatch.setattr(controller, "_sandbox_from_id",
                        lambda sid: (_ for _ in ()).throw(
                            RuntimeError("no such sandbox")))
    return tmp_path, state


def events(tmp_path, run_id):
    with open(tmp_path / run_id / "events.jsonl") as f:
        return [json.loads(l) for l in f]


def test_regression_run_survives_missing_investigator(wired, monkeypatch):
    tmp_path, state = wired
    monkeypatch.setattr(
        paired_runner, "run_blocks",
        lambda sb, spec, ev, overrides=None, volume=None, on_block=None, **kw:
        [block("base", 0, 400.0), block("head", 1, 300.0),
         block("head", 2, 300.0), block("base", 3, 400.0)])
    report = controller.run(SPEC)
    assert report["verdict"]["verdict"] == "regression"
    # a normally-completed run parks its sandbox warm instead of terminating
    assert state["terminated"] is False
    assert state["pool"]["sb-fake"]["state"] == "cooldown"
    d = tmp_path / "t_ctl"
    for f in ("spec.json", "verdict.json", "investigation.json", "report.json"):
        assert (d / f).exists(), f
    inv = json.loads((d / "investigation.json").read_text())
    assert inv["status"] == "failed"  # Tier-1 survival: investigator absent
    assert "inconclusive" in inv["diagnosis"]["text"]
    kinds = [e["kind"] for e in events(tmp_path, "t_ctl")]
    for k in ("submitted", "plan_fallback", "sandbox_up", "revisions_ready",
              "preflight_ok", "verdict", "investigation_started",
              "investigation_done", "sandbox_parked", "report_ready"):
        assert k in kinds, k
    assert kinds.index("sandbox_parked") < kinds.index("report_ready")


def test_pass_run_skips_investigation(wired, monkeypatch):
    tmp_path, state = wired
    monkeypatch.setattr(
        paired_runner, "run_blocks",
        lambda sb, spec, ev, overrides=None, volume=None, on_block=None, **kw:
        [block("base", 0, 400.0), block("head", 1, 401.0),
         block("head", 2, 401.0), block("base", 3, 400.0)])
    report = controller.run(SPEC)
    assert report["verdict"]["verdict"] == "pass"
    assert "investigation" not in report
    assert not (tmp_path / "t_ctl" / "investigation.json").exists()
    assert state["terminated"] is False  # parked warm, not terminated
    assert state["pool"]["sb-fake"]["state"] == "cooldown"


def test_preflight_failure_still_reports(wired, monkeypatch):
    tmp_path, state = wired
    monkeypatch.setattr(paired_runner, "preflight",
                        lambda sb, spec, volume=None:
                        [block("base", 0, 1.0),
                         block("head", 1, 0.0, status="failed")])
    called = []
    monkeypatch.setattr(paired_runner, "run_blocks",
                        lambda *a, **kw: called.append(1))
    report = controller.run(SPEC)
    assert not called  # measured blocks skipped
    assert report["verdict"]["verdict"] == "regression"  # head-only failure
    # the run itself completed normally (the failure IS the evidence) -> park
    assert state["terminated"] is False
    assert state["pool"]["sb-fake"]["state"] == "cooldown"


def test_infra_crash_yields_invalid_report(wired, monkeypatch):
    tmp_path, state = wired
    monkeypatch.setattr(sandbox_mgr, "create_sandbox",
                        lambda *a, **kw: (_ for _ in ()).throw(
                            RuntimeError("no GPUs")))
    report = controller.run(SPEC)
    assert report["verdict"]["verdict"] == "invalid"
    assert "no GPUs" in report["verdict"]["invalid_reason"]
    assert (tmp_path / "t_ctl" / "report.json").exists()
    assert state["pool"] == {}  # no sandbox ever existed: nothing to park


def test_validate_spec():
    with pytest.raises(ValueError):
        controller.validate_spec({**SPEC, "mode": "race"})
    with pytest.raises(ValueError):
        controller.validate_spec({k: v for k, v in SPEC.items()
                                  if k != "head_sha"})
    bad = {**SPEC, "evals": [{"name": "", "cmd": "x"}]}
    with pytest.raises(ValueError):
        controller.validate_spec(bad)
    controller.validate_spec(SPEC)  # good spec passes


def test_probe_overrides():
    assert controller.probe_overrides(
        {"eval": "gen", "repeats": 8, "tokens": 64}) == {"repeats": 8,
                                                         "tokens": 64}
    assert controller.probe_overrides(
        {"eval": "gen", "override": "batch", "value": 1,
         "repeats": 3}) == {"batch": 1, "repeats": 3}


def test_needs_investigation():
    v = {"verdict": "pass", "checks": [{"violated": False}]}
    assert not controller.needs_investigation(v)
    assert controller.needs_investigation({**v, "verdict": "regression"})
    assert controller.needs_investigation(
        {"verdict": "pass", "checks": [{"violated": False, "flagged": True}]})
