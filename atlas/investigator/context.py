"""Compact initial context for the investigator. Hard-capped; never raw logs.

Reads spec.json, verdict.json and blocks/*.json under runs/<id>/ and renders
a short factual brief: the run, the verdict with per-check deltas, one line
per bench block, an artifact index (paths + sizes only), the claim and the
diff. Log *contents* never appear here — the agent retrieves bounded slices
through tools.
"""
import json
import os
import statistics

CAP_BYTES = 4096
TRUNCATION_MARK = "\n...[context truncated]"
_DIFF_CAP = 1200
_INDEX_CAP = 40


def _load(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _block_line(b: dict) -> str:
    if b.get("status") != "completed":
        return f"- b{b.get('block')} {b.get('label')} {b.get('eval')}: FAILED {b.get('error', '')[:80]}"
    s = b.get("summary") or {}
    vals = []
    for m in ("tokens_per_s", "latency_ms_p95", "peak_vram_mb"):
        v = s.get(m)
        if v is None and b.get("samples", {}).get(m):
            v = statistics.median(b["samples"][m])
        if v is not None:
            vals.append(f"{m}={v:.1f}")
    return f"- b{b['block']} {b['label']} {b['eval']}: " + ", ".join(vals)


def _artifact_index(run_dir: str) -> list[str]:
    rows = []
    for root, _, files in os.walk(run_dir):
        for name in sorted(files):
            p = os.path.join(root, name)
            rel = os.path.relpath(p, run_dir)
            rows.append(f"- {rel} ({os.path.getsize(p)}B)")
    rows.sort()
    if len(rows) > _INDEX_CAP:
        rows = rows[:_INDEX_CAP] + [f"- ... {len(rows) - _INDEX_CAP} more"]
    return rows


def build_context(run_id: str, runs_root: str, cap_bytes: int = CAP_BYTES) -> str:
    run_dir = os.path.join(runs_root, run_id)
    spec = _load(os.path.join(run_dir, "spec.json"))
    verdict = _load(os.path.join(run_dir, "verdict.json"))

    lines = [f"# Run {run_id} ({spec['mode']} mode)",
             f"repo {spec['repo']}  base {spec['base_sha'][:8]} -> head {spec.get('head_sha', '-')[:8]}"
             f"  gpu {spec['gpu']}"]
    for ev in spec.get("evals", []):
        lines.append(f"- eval {ev['name']}: `{ev['cmd']}` checks {ev.get('checks', {})}")
    if spec.get("claim"):
        lines += ["", f"## PR claim", spec["claim"]]

    lines += ["", f"## Verdict: {verdict['verdict'].upper()}"]
    for c in verdict.get("checks", []):
        mark = "VIOLATED" if c["violated"] else "ok"
        flag = " (near noise band)" if c.get("flagged") else ""
        if "delta_pct" in c:
            lines.append(f"- {c['eval']} {c['metric']}: {c.get('base')} -> {c['cand']} "
                         f"({c['delta_pct']:+.1f}%, threshold {c['threshold']}) {mark}{flag}")
        else:
            lines.append(f"- {c['eval']} {c['metric']}: {c['cand']} (threshold {c['threshold']}) {mark}{flag}")
    lines.append(f"- correctness: {verdict.get('correctness', {}).get('result', 'n/a')}")
    if verdict.get("invalid_reason"):
        lines.append(f"- invalid_reason: {verdict['invalid_reason']}")

    blocks_dir = os.path.join(run_dir, "blocks")
    if os.path.isdir(blocks_dir):
        lines += ["", "## Bench blocks"]
        for name in sorted(os.listdir(blocks_dir)):
            if name.endswith(".json"):
                lines.append(_block_line(_load(os.path.join(blocks_dir, name))))

    lines += ["", "## Artifacts (read via tools; paths are relative to the run dir)"]
    lines += _artifact_index(run_dir)

    if spec.get("diff"):
        d = spec["diff"]
        lines += ["", "## Diff", d[:_DIFF_CAP] + ("\n...[diff truncated]" if len(d) > _DIFF_CAP else "")]

    text = "\n".join(lines)
    if len(text.encode()) > cap_bytes:
        keep = cap_bytes - len(TRUNCATION_MARK.encode())
        text = text.encode()[:keep].decode(errors="ignore") + TRUNCATION_MARK
    return text
