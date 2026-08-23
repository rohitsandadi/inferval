"""Block results -> Verdict. Pure functions, zero Modal, fully local-testable.

Rules (v2/ARCHITECTURE.md):
- validity first: both sides failed or data malformed -> invalid;
  candidate-only failure -> regression
- correctness before performance; a faster wrong answer is a regression
- relative checks in compare mode, absolute checks in check mode
- near-band results are flagged, never silently rounded to a confident call
- nothing in here is an LLM output
"""
import statistics
from typing import Any

from atlas.referee import policy


def _pool(blocks: list[dict], label: str, eval_name: str, source: str) -> list[float]:
    vals: list[float] = []
    for b in blocks:
        if b["label"] == label and b["eval"] == eval_name and b["status"] == "completed":
            vals.extend(b["samples"].get(source, []))
    return vals


def _summaries(blocks: list[dict], label: str, eval_name: str, source: str) -> list[float]:
    return [b["summary"][source] for b in blocks
            if b["label"] == label and b["eval"] == eval_name
            and b["status"] == "completed" and source in b.get("summary", {})]


def _median(blocks: list[dict], label: str, eval_name: str, metric: str) -> float | None:
    src = policy.METRICS[metric]["source"]
    vals = _pool(blocks, label, eval_name, src)
    if not vals:
        # the harness emits derived metrics (e.g. latency_ms_p95) only in the
        # per-block summary, never as a samples key
        vals = _summaries(blocks, label, eval_name, src)
    return statistics.median(vals) if vals else None


def correctness(blocks: list[dict]) -> dict[str, Any]:
    """Exact output-id match per eval between base and head, plus internal
    repeat consistency."""
    by_eval: dict[str, dict[str, list]] = {}
    for b in blocks:
        if b["status"] != "completed" or b.get("output_ids") is None:
            continue
        by_eval.setdefault(b["eval"], {}).setdefault(b["label"], []).append(
            (b["output_ids"], b.get("outputs_consistent", True)))
    details = {}
    overall = "match"
    for ev, sides in by_eval.items():
        if not all(c for rows in sides.values() for _, c in rows):
            details[ev] = "inconsistent_repeats"
            overall = "mismatch"
            continue
        ids = {label: rows[0][0] for label, rows in sides.items()}
        if "base" in ids and "head" in ids:
            ok = ids["base"] == ids["head"]
            details[ev] = "match" if ok else "mismatch"
            if not ok:
                overall = "mismatch"
        else:
            details[ev] = "single_side"
    if not by_eval:
        overall = "n/a"
    return {"result": overall, "per_eval": details}


def evaluate(run_spec: dict, blocks: list[dict],
             noise_margin: float = policy.NOISE_MARGIN_PCT) -> dict:
    """Produce the Verdict for a run from its block results."""
    run = run_spec["run"]
    mode = run_spec["mode"]
    verdict: dict[str, Any] = {"schema": "1", "run": run, "checks": [],
                               "correctness": {"result": "n/a"}}

    completed = [b for b in blocks if b.get("status") == "completed"]
    failed = [b for b in blocks if b.get("status") == "failed"]

    labels_done = {b["label"] for b in completed}
    if mode == "compare":
        if "base" not in labels_done and "head" not in labels_done:
            verdict["verdict"] = "invalid"
            verdict["invalid_reason"] = ("both revisions failed: "
                                         + (failed[0].get("error", "unknown") if failed else "no data"))
            return verdict
        if "base" not in labels_done:
            verdict["verdict"] = "invalid"
            verdict["invalid_reason"] = "base failed; no fair comparison possible"
            return verdict
        if "head" not in labels_done:
            verdict["verdict"] = "regression"
            verdict["correctness"] = {"result": "n/a"}
            verdict["checks"] = [{
                "metric": "execution", "eval": failed[0]["eval"] if failed else "?",
                "cand": 0.0, "threshold": "must run", "violated": True}]
            verdict["invalid_reason"] = ""
            return verdict

    corr = correctness(completed)
    verdict["correctness"] = corr
    checks: list[dict] = []
    violated_any = corr["result"] == "mismatch"

    for ev in run_spec["evals"]:
        ev_name = ev["name"]
        if mode == "compare":
            for metric, thr in ev.get("checks", {}).items():
                if metric not in policy.METRICS:
                    verdict["verdict"] = "invalid"
                    verdict["invalid_reason"] = f"unknown metric in checks: {metric}"
                    return verdict
                b = _median(completed, "base", ev_name, metric)
                h = _median(completed, "head", ev_name, metric)
                if b is None or h is None or b == 0:
                    continue  # eval not run in this plan
                delta = (h / b - 1) * 100
                viol = policy.relative_violated(metric, delta, thr)
                c = {"metric": metric, "eval": ev_name, "base": round(b, 3),
                     "cand": round(h, 3), "delta_pct": round(delta, 2),
                     "threshold": thr, "violated": viol}
                if policy.near_band(delta, thr, noise_margin):
                    c["flagged"] = True
                checks.append(c)
                violated_any = violated_any or viol
        else:  # check mode: absolute thresholds on the single revision
            for metric, expr in ev.get("absolute", {}).items():
                v = _median(completed, "base", ev_name, metric)
                if v is None:
                    continue
                viol = policy.absolute_violated(v, expr)
                checks.append({"metric": metric, "eval": ev_name,
                               "cand": round(v, 3), "threshold": expr,
                               "violated": viol})
                violated_any = violated_any or viol

    verdict["checks"] = checks
    if not checks and corr["result"] == "n/a":
        verdict["verdict"] = "invalid"
        verdict["invalid_reason"] = "no usable metrics produced"
        return verdict
    verdict["verdict"] = "regression" if violated_any else "pass"
    if run_spec.get("claim"):
        verdict["claim"] = {"text": run_spec["claim"],
                            "verified": None if verdict["verdict"] == "invalid"
                            else not violated_any}
    return verdict
