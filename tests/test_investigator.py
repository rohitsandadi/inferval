"""M3 investigator tests: probes, context cap, tool bounds, approval flow,
ledger. No network — the model never runs here (loop.py is smoke-tested live
by scripts/investigator_smoke.py)."""
import json
import os

import pytest

from atlas.investigator.context import CAP_BYTES, TRUNCATION_MARK, build_context
from atlas.investigator.probes import CEILINGS, ProbeError, validate_probe
from atlas.investigator.tools import (ToolContext, propose_probe, read_log_window,
                                      read_metrics, search_logs)

EVALS = ["generate_short", "generate_long"]
OVERRIDES = ["batch"]


def block(label, tps, lat, eval_name="generate_short", vram=1912.0, block_i=0,
          profile=None):
    b = {"schema": "1", "status": "completed", "label": label, "block": block_i,
         "eval": eval_name, "params": {},
         "samples": {"tokens_per_s": [tps * 0.99, tps, tps * 1.01],
                     "latency_ms_median": [lat] * 3,
                     "latency_ms_p95": [lat * 1.1] * 3,
                     "peak_vram_mb": [vram] * 3},
         "output_ids": [[1, 2, 3]], "outputs_consistent": True,
         "timing": "cuda_sync_wall", "env": {}}
    if profile:
        b["profile"] = profile
    return b


def make_run_dir(tmp_path, approvals="auto", diff=None):
    run_dir = tmp_path / "r_t1"
    (run_dir / "blocks").mkdir(parents=True)
    spec = {"schema": "1", "run": "r_t1", "mode": "compare", "repo": "x/nanoGPT",
            "base_sha": "3adf61e1", "head_sha": "9c2b11d0", "gpu": "A10G",
            "image": "img", "selection": "auto", "approvals": approvals,
            "claim": "~2x faster generation", "overrides": OVERRIDES,
            "evals": [{"name": n, "cmd": "python bench.py",
                       "checks": {"tokens_per_s": "-10%"}} for n in EVALS]}
    if diff:
        spec["diff"] = diff
    verdict = {"schema": "1", "run": "r_t1", "verdict": "regression",
               "correctness": {"result": "match"},
               "checks": [{"metric": "tokens_per_s", "eval": "generate_short",
                           "base": 412.3, "cand": 276.2, "delta_pct": -33.0,
                           "threshold": "-10%", "violated": True}]}
    (run_dir / "spec.json").write_text(json.dumps(spec))
    (run_dir / "verdict.json").write_text(json.dumps(verdict))
    for i, (label, tps) in enumerate([("base", 412.3), ("head", 276.2)]):
        (run_dir / "blocks" / f"b{i}_{label}_generate_short.json").write_text(
            json.dumps(block(label, tps, 320, block_i=i)))
    (run_dir / "logs").mkdir()
    (run_dir / "logs" / "head.stderr").write_text(
        "line one\nSECRETLOGLINE cudaMemcpy warning\nline three\n" * 5)
    (run_dir / "events.jsonl").write_text(json.dumps(
        {"t": "0", "run": "r_t1", "tier": "policy", "kind": "verdict",
         "detail": {"verdict": "regression"}}) + "\n")
    return str(tmp_path), spec


def make_ctx(tmp_path, approvals="auto", callback=None, lookup=None, **kw):
    root, spec = make_run_dir(tmp_path, approvals=approvals)
    calls = []

    def default_callback(kind, params):
        calls.append((kind, params))
        prof = ({"total_cpu_ms": 1500, "top_ops": [{"name": "aten::_local_scalar_dense",
                 "cpu_ms": 690}]} if kind == "profile_pair" else None)
        return [block("base", 412.3, 320, params["eval"], block_i=0, profile=prof),
                block("head", 276.2, 480, params["eval"], block_i=1, profile=prof)]

    ctx = ToolContext(run_id="r_t1", runs_root=root, spec=spec,
                      probe_callback=callback or default_callback,
                      approval_lookup=lookup or (lambda key: "approved"), **kw)
    return ctx, calls


# --- probes --------------------------------------------------------------

def test_confirm_defaults():
    clean, est = validate_probe("confirm_pair", {"eval": "generate_short"}, EVALS, OVERRIDES)
    assert clean == {"eval": "generate_short", "repeats": 5, "order": "abba"}
    assert est > 0


def test_unknown_kind_and_eval():
    with pytest.raises(ProbeError):
        validate_probe("mystery", {"eval": "generate_short"}, EVALS, OVERRIDES)
    with pytest.raises(ProbeError):
        validate_probe("confirm_pair", {"eval": "nope"}, EVALS, OVERRIDES)


def test_repeats_ceiling():
    with pytest.raises(ProbeError):
        validate_probe("confirm_pair", {"eval": "generate_short",
                       "repeats": CEILINGS["max_repeats"] + 1}, EVALS, OVERRIDES)


def test_order_validated():
    with pytest.raises(ProbeError):
        validate_probe("confirm_pair", {"eval": "generate_short", "order": "ba"},
                       EVALS, OVERRIDES)


def test_profile_tokens_ceiling_and_fixed_repeats():
    clean, _ = validate_probe("profile_pair", {"eval": "generate_long"}, EVALS, OVERRIDES)
    assert clean["tokens"] == 32 and clean["repeats"] == 1
    with pytest.raises(ProbeError):
        validate_probe("profile_pair", {"eval": "generate_long",
                       "tokens": CEILINGS["max_profile_tokens"] + 1}, EVALS, OVERRIDES)


def test_override_whitelist():
    clean, _ = validate_probe("override_pair", {"eval": "generate_short",
                              "override": "batch", "value": 4}, EVALS, OVERRIDES)
    assert clean["override"] == "batch" and clean["value"] == 4
    with pytest.raises(ProbeError):
        validate_probe("override_pair", {"eval": "generate_short",
                       "override": "lr", "value": 4}, EVALS, OVERRIDES)
    with pytest.raises(ProbeError):
        validate_probe("override_pair", {"eval": "generate_short",
                       "override": "batch"}, EVALS, OVERRIDES)


# --- context -------------------------------------------------------------

def test_context_capped(tmp_path):
    root, _ = make_run_dir(tmp_path, diff="+" + "x" * 10000)
    ctx = build_context("r_t1", root)
    assert len(ctx.encode()) <= CAP_BYTES
    assert "[diff truncated]" in ctx        # section cap fired first
    small = build_context("r_t1", root, cap_bytes=512)
    assert len(small.encode()) <= 512 and small.endswith(TRUNCATION_MARK)


def test_context_facts_no_raw_logs(tmp_path):
    root, _ = make_run_dir(tmp_path)
    ctx = build_context("r_t1", root)
    assert "REGRESSION" in ctx and "-33.0%" in ctx and "~2x faster" in ctx
    assert "SECRETLOGLINE" not in ctx          # log contents never leak in
    assert os.path.join("logs", "head.stderr") in ctx  # but the index lists them


# --- read tools ----------------------------------------------------------

def test_read_metrics_primary_drops_output_ids(tmp_path):
    ctx, _ = make_ctx(tmp_path)
    out = read_metrics(ctx, "primary")
    assert "tokens_per_s" in out and "output_ids" not in out


def test_read_log_window_bounds_and_traversal(tmp_path):
    ctx, _ = make_ctx(tmp_path)
    out = read_log_window(ctx, "logs/head.stderr", 2, 2)
    assert "SECRETLOGLINE" in out and "line one" not in out
    assert "outside the run dir" in read_log_window(ctx, "../../etc/passwd", 1, 5)


def test_search_logs(tmp_path):
    ctx, _ = make_ctx(tmp_path)
    out = search_logs(ctx, "secretlogline")
    assert "head.stderr:2:" in out


# --- propose_probe -------------------------------------------------------

def test_auto_mode_skips_wait_and_executes(tmp_path):
    def never(key):
        raise AssertionError("approval_lookup must not be polled in auto mode")
    ctx, calls = make_ctx(tmp_path, approvals="auto")
    ctx.approval_lookup = never
    out = propose_probe(ctx, "profile_pair", "generate_long", "where did time move")
    assert out.startswith("probe p1 done") and "e1" in out
    assert len(calls) == 1 and calls[0][0] == "profile_pair"
    prop = ctx.proposals[0]
    assert prop["status"] == "done" and prop["experiment"] == "e1"
    assert ctx.experiments_run == 1 and ctx.gpu_seconds_used > 0
    events = open(os.path.join(ctx.run_dir, "events.jsonl")).read()
    assert "probe_proposed" in events and "probe_done" in events
    assert "aten::_local_scalar_dense" in read_metrics(ctx, "e1")


def test_denied_returns_not_run(tmp_path):
    ctx, calls = make_ctx(tmp_path, approvals="manual", lookup=lambda key: "denied")
    out = propose_probe(ctx, "confirm_pair", "generate_short", "noise?")
    assert "not run" in out and "denied" in out
    assert ctx.proposals[0]["status"] == "denied"
    assert not calls and ctx.experiments_run == 0 and ctx.gpu_seconds_used == 0


def test_approval_timeout_expires(tmp_path):
    ctx, calls = make_ctx(tmp_path, approvals="manual", lookup=lambda key: None,
                          approval_timeout_s=0.05, poll_interval_s=0.01)
    out = propose_probe(ctx, "confirm_pair", "generate_short", "noise?")
    assert "not run" in out and "expired" in out
    assert ctx.proposals[0]["status"] == "expired" and not calls


def test_manual_approval_executes(tmp_path):
    ctx, calls = make_ctx(tmp_path, approvals="manual",
                          lookup=lambda key: "approved", poll_interval_s=0.01)
    out = propose_probe(ctx, "confirm_pair", "generate_short", "noise?")
    assert out.startswith("probe p1 done") and len(calls) == 1


def test_experiment_budget_exhausted(tmp_path):
    ctx, calls = make_ctx(tmp_path, max_experiments=0)
    out = propose_probe(ctx, "confirm_pair", "generate_short", "noise?")
    assert "not run" in out and "budget exhausted" in out
    assert not calls and not ctx.proposals


def test_gpu_seconds_budget_exhausted(tmp_path):
    ctx, calls = make_ctx(tmp_path, gpu_seconds_budget=1.0)
    out = propose_probe(ctx, "confirm_pair", "generate_short", "noise?")
    assert "GPU-seconds budget exhausted" in out and not calls


def test_invalid_params_reported_not_recorded(tmp_path):
    ctx, calls = make_ctx(tmp_path)
    out = propose_probe(ctx, "confirm_pair", "generate_short", "x", repeats=99)
    assert out.startswith("invalid probe") and not ctx.proposals and not calls
