"""Verdict + Investigation -> Report (JSON for the UI, Markdown for the PR)."""
from typing import Any


def _fmt_check(c: dict) -> str:
    flag = "  《near noise band — flagged》" if c.get("flagged") else ""
    mark = "FAIL" if c["violated"] else "OK"
    if "delta_pct" in c:
        return (f"{mark} `{c['eval']}` {c['metric']}: {c.get('base', '?')} → "
                f"{c['cand']}  (**{c['delta_pct']:+.1f}%**, limit {c['threshold']}){flag}")
    return f"{mark} `{c['eval']}` {c['metric']}: {c['cand']} (limit {c['threshold']}){flag}"


def build_report(verdict: dict, investigation: dict | None = None,
                 greptile_ping: bool = False) -> dict:
    v = verdict["verdict"]
    checks = verdict.get("checks", [])
    summary: list[str] = []
    flagged: list[str] = []

    claim = verdict.get("claim") or {}
    if claim.get("text"):
        state = {True: "VERIFIED", False: "NOT TRUE", None: "UNVERIFIED"}[claim.get("verified")]
        summary.append(f'Claim "{claim["text"]}" — **{state}** by measurement.')

    if v == "invalid":
        summary.append(f"No fair comparison possible: {verdict.get('invalid_reason', 'unknown')}")
    else:
        viols = [c for c in checks if c["violated"]]
        if viols:
            worst = max(viols, key=lambda c: abs(c.get("delta_pct", 0)))
            summary.append(
                f"{len(viols)} check(s) violated; worst: {worst['metric']} on "
                f"`{worst['eval']}` at {worst.get('delta_pct', '?')}% (limit {worst['threshold']}).")
        else:
            summary.append("All checks passed.")
        corr = verdict.get("correctness", {})
        summary.append(f"Output correctness: {corr.get('result', 'n/a')}.")

    for c in checks:
        if c.get("flagged"):
            flagged.append(f"{c['metric']} on `{c['eval']}` is within the noise "
                           f"band of its threshold ({c.get('delta_pct')}% vs "
                           f"{c['threshold']}) — read with care.")
    if investigation:
        for p in investigation.get("proposals", []):
            if p["status"] in ("denied", "expired", "proposed"):
                flagged.append(f"Proposed but not run: {p['kind']} — {p['reason']}")

    # PR comment
    lines = [f"## Inferval: {v.upper()}", ""]
    lines += [f"- {s}" for s in summary]
    if checks:
        lines += ["", "**Measured (policy decision, not a model output):**", ""]
        lines += [_fmt_check(c) for c in checks]
    if investigation and investigation.get("diagnosis"):
        d = investigation["diagnosis"]
        lines += ["", f"**Diagnosis** ({d.get('confidence', '?')} confidence): {d['text']}"]
        obs = investigation.get("observations", [])
        if obs:
            lines += ["", "<details><summary>Evidence</summary>", ""]
            lines += [f"- {o['text']} ({', '.join(o['refs'])})" for o in obs]
            lines += ["", "</details>"]
    if flagged:
        lines += ["", "**Flagged:**"] + [f"- {f}" for f in flagged]
    if greptile_ping and v == "regression":
        lines += ["", "@greptileai correlate the measured runtime evidence above "
                      "with the changed code paths in this PR."]
    report: dict[str, Any] = {"schema": "1", "run": verdict["run"],
                              "verdict": verdict, "summary": summary,
                              "flagged": flagged,
                              "pr_comment_md": "\n".join(lines)}
    if investigation:
        report["investigation"] = investigation
    return report
