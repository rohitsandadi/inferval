"""M2 referee tests: the required checks from v2/BUILD_PLAN.md, on fixtures."""
import copy
import statistics

from atlas.referee.comparator import evaluate
from atlas.referee.report import build_report

SPEC = {"schema": "1", "run": "t1", "mode": "compare", "repo": "x",
        "base_sha": "a", "head_sha": "b", "gpu": "A10G", "image": "img",
        "selection": "all", "approvals": "auto",
        "claim": "2x faster generation",
        "evals": [{"name": "gen", "cmd": "x",
                   "checks": {"tokens_per_s": "-10%", "latency_ms_p95": "+15%",
                              "peak_vram_mb": "+8%"},
                   "absolute": {"latency_ms_p95": "<500"}}]}


def block(label, tps, lat, vram=1000.0, ids=None, status="completed", block_i=0):
    return {"schema": "1", "status": status, "label": label, "block": block_i,
            "eval": "gen", "params": {},
            "samples": {"tokens_per_s": [tps * 0.99, tps, tps * 1.01],
                        "latency_ms_median": [lat] * 3,
                        "latency_ms_p95": [lat * 1.1] * 3,
                        "peak_vram_mb": [vram] * 3},
            "output_ids": ids if ids is not None else [[1, 2, 3]],
            "outputs_consistent": True, "timing": "cuda_sync_wall", "env": {},
            **({"error": "boom"} if status == "failed" else {})}


def test_pass():
    v = evaluate(SPEC, [block("base", 400, 300), block("head", 395, 302)])
    assert v["verdict"] == "pass"
    assert v["claim"]["verified"] is True


def test_relative_regression():
    v = evaluate(SPEC, [block("base", 400, 300), block("head", 300, 400)])
    assert v["verdict"] == "regression"
    assert any(c["violated"] and c["metric"] == "tokens_per_s" for c in v["checks"])
    assert v["claim"]["verified"] is False


def test_correctness_overrides_speed():
    v = evaluate(SPEC, [block("base", 400, 300, ids=[[1, 2, 3]]),
                        block("head", 800, 150, ids=[[9, 9, 9]])])
    assert v["verdict"] == "regression"
    assert v["correctness"]["result"] == "mismatch"


def test_candidate_only_failure_is_regression():
    v = evaluate(SPEC, [block("base", 400, 300),
                        block("head", 0, 0, status="failed")])
    assert v["verdict"] == "regression"


def test_both_fail_invalid():
    v = evaluate(SPEC, [block("base", 0, 0, status="failed"),
                        block("head", 0, 0, status="failed")])
    assert v["verdict"] == "invalid"


def test_unknown_metric_invalid():
    spec = copy.deepcopy(SPEC)
    spec["evals"][0]["checks"]["made_up_metric"] = "-5%"
    v = evaluate(spec, [block("base", 400, 300), block("head", 395, 300)])
    assert v["verdict"] == "invalid"


def test_near_band_flagged_not_violated():
    # -8.8% vs -10% threshold with 3% margin -> pass but flagged
    v = evaluate(SPEC, [block("base", 400, 300), block("head", 364.8, 300)])
    assert v["verdict"] == "pass"
    tps = next(c for c in v["checks"] if c["metric"] == "tokens_per_s")
    assert tps.get("flagged") is True and not tps["violated"]


def test_check_mode_absolute():
    spec = copy.deepcopy(SPEC)
    spec["mode"] = "check"
    ok = evaluate(spec, [block("base", 400, 300)])
    assert ok["verdict"] == "pass"
    bad = evaluate(spec, [block("base", 400, 600)])
    assert bad["verdict"] == "regression"


def bench_block(label, walls, tps, vram=1000.0):
    """BlockResult shaped exactly like demo/bench.py output: samples has
    latency_ms (no latency_ms_p95/median keys); p95 lives only in summary."""
    return {"schema": "1", "status": "completed", "label": label, "block": 0,
            "eval": "gen", "params": {},
            "samples": {"latency_ms": walls, "tokens_per_s": tps,
                        "peak_vram_mb": [vram] * len(walls),
                        "peak_vram_reserved_mb": [vram] * len(walls)},
            "summary": {"tokens_per_s": statistics.median(tps),
                        "latency_ms_median": statistics.median(walls),
                        "latency_ms_p95": sorted(walls)[max(0, int(len(walls) * 0.95) - 1)],
                        "peak_vram_mb": vram},
            "output_ids": [[1, 2, 3]], "outputs_consistent": True,
            "timing": "cuda_sync_wall", "env": {}}


def test_p95_check_appears_for_bench_shaped_samples():
    # base p95 = 303, head p95 = 403 -> +33% vs "+15%" threshold -> violated
    v = evaluate(SPEC, [
        bench_block("base", [300, 301, 302, 303, 304], [396, 398, 400, 402, 404]),
        bench_block("head", [400, 401, 402, 403, 404], [391, 393, 395, 397, 399])])
    p95 = next((c for c in v["checks"] if c["metric"] == "latency_ms_p95"), None)
    assert p95 is not None, "latency_ms_p95 check silently skipped"
    assert p95["base"] == 303 and p95["cand"] == 403
    assert p95["violated"] is True
    assert v["verdict"] == "regression"


def test_report_renders():
    v = evaluate(SPEC, [block("base", 400, 300), block("head", 300, 400)])
    r = build_report(v, greptile_ping=True)
    md = r["pr_comment_md"]
    assert "REGRESSION" in md and "NOT TRUE" in md and "@greptileai" in md
    assert r["summary"] and isinstance(r["flagged"], list)
