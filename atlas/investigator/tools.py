"""Investigator tools: bounded file reads under runs/<id>/ plus propose_probe.

The plain functions here are directly testable; make_tools() wraps them as
Agents SDK function tools closing over one ToolContext. Probes never execute
directly: propose_probe validates against ceilings, emits a probe_proposed
event, waits for approval (skipped when the spec says approvals: auto), and
only then runs the controller-injected probe_callback. The GPU-seconds ledger
and the max-experiments ceiling are enforced here, outside the model.

Controller wiring:
  probe_callback(kind: str, params: dict) -> list[BlockResult dicts]
      production: M1's run_blocks with the probe params; tests: a mock.
  approval_lookup(key: str) -> "approved" | "denied" | None
      production: modal.Dict.from_name(names.DICT_APPROVALS).get;
      key is f"{run_id}:{proposal_id}".
"""
import json
import os
import statistics
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from agents import function_tool

from atlas.investigator import probes
from atlas.referee.events import append_event

READ_CAP_BYTES = 8000       # per read_metrics call
SEARCH_MAX_LINES = 40
WINDOW_MAX_LINES = 200
LINE_CAP = 300


@dataclass
class ToolContext:
    run_id: str
    runs_root: str
    spec: dict
    probe_callback: Callable[[str, dict], list[dict]]
    approval_lookup: Callable[[str], str | None]
    max_experiments: int = 3
    gpu_seconds_budget: float = 240.0
    approval_timeout_s: float = 1800.0
    poll_interval_s: float = 2.0
    # ledger — mutated as probes execute
    gpu_seconds_used: float = 0.0
    experiments_run: int = 0
    proposals: list[dict] = field(default_factory=list)

    @property
    def run_dir(self) -> str:
        return os.path.join(self.runs_root, self.run_id)


def _resolve(ctx: ToolContext, rel: str) -> str | None:
    """Path under the run dir, or None if it escapes it."""
    p = os.path.realpath(os.path.join(ctx.run_dir, rel))
    root = os.path.realpath(ctx.run_dir)
    return p if p == root or p.startswith(root + os.sep) else None


def read_metrics(ctx: ToolContext, experiment: str) -> str:
    """'primary' -> blocks/, else experiments/<eid>/. output_ids dropped, byte-capped."""
    sub = "blocks" if experiment == "primary" else os.path.join("experiments", experiment)
    d = _resolve(ctx, sub)
    if d is None or not os.path.isdir(d):
        return f"no metrics for experiment {experiment!r}"
    out, used = [], 0
    for name in sorted(os.listdir(d)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name)) as f:
                obj = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            out.append(f"{name}: unreadable ({e})")
            continue
        if isinstance(obj, dict):
            obj.pop("output_ids", None)
        s = json.dumps(obj, separators=(",", ":"))
        if used + len(s) > READ_CAP_BYTES:
            s = s[:READ_CAP_BYTES - used] + "...[truncated]"
        out.append(f"{sub}/{name}: {s}")
        used += len(s)
        if used >= READ_CAP_BYTES:
            break
    return "\n".join(out) or f"no files under {sub}/"


def search_logs(ctx: ToolContext, query: str) -> str:
    """Case-insensitive substring search over retained text artifacts."""
    q = query.lower()
    hits = []
    for root, _, files in os.walk(ctx.run_dir):
        for name in sorted(files):
            if not name.endswith((".jsonl", ".log", ".txt", ".stderr", ".stdout")):
                continue
            rel = os.path.relpath(os.path.join(root, name), ctx.run_dir)
            try:
                with open(os.path.join(root, name), errors="replace") as f:
                    for i, line in enumerate(f, 1):
                        if q in line.lower():
                            hits.append(f"{rel}:{i}: {line.strip()[:LINE_CAP]}")
                            if len(hits) >= SEARCH_MAX_LINES:
                                return "\n".join(hits) + "\n...[more matches not shown]"
            except OSError:
                continue
    return "\n".join(hits) or f"no matches for {query!r}"


def read_log_window(ctx: ToolContext, artifact: str, start: int, end: int) -> str:
    """Lines [start, end] (1-based) of one artifact, bounded."""
    p = _resolve(ctx, artifact)
    if p is None:
        return f"path {artifact!r} is outside the run dir"
    if not os.path.isfile(p):
        return f"no artifact at {artifact!r}"
    start = max(1, start)
    end = min(end, start + WINDOW_MAX_LINES - 1)
    out = []
    with open(p, errors="replace") as f:
        for i, line in enumerate(f, 1):
            if i > end:
                break
            if i >= start:
                out.append(f"{i}: {line.rstrip()[:LINE_CAP]}")
    return "\n".join(out) or f"{artifact}: empty window [{start}, {end}]"


def _budget_reject_reason(ctx: ToolContext, est: float) -> str | None:
    if ctx.experiments_run >= ctx.max_experiments:
        return (f"experiment budget exhausted ({ctx.experiments_run}/{ctx.max_experiments} used); "
                "finish with the evidence you have")
    if ctx.gpu_seconds_used + est > ctx.gpu_seconds_budget:
        return (f"GPU-seconds budget exhausted ({ctx.gpu_seconds_used:.0f}s used, "
                f"{ctx.gpu_seconds_budget:.0f}s ceiling, probe needs {est:.0f}s); "
                "finish with the evidence you have")
    return None


def _wait_approval(ctx: ToolContext, pid: str) -> str:
    key = f"{ctx.run_id}:{pid}"
    deadline = time.monotonic() + ctx.approval_timeout_s
    while time.monotonic() < deadline:
        decision = ctx.approval_lookup(key)
        if decision in ("approved", "denied"):
            return decision
        time.sleep(ctx.poll_interval_s)
    return "expired"


def _summarize_blocks(blocks: list[dict]) -> str:
    lines = []
    medians: dict[str, float] = {}
    for b in blocks:
        if b.get("status") != "completed":
            lines.append(f"{b.get('label')}: FAILED {b.get('error', '')[:120]}")
            continue
        vals = []
        for m in ("tokens_per_s", "latency_ms_p95", "peak_vram_mb"):
            xs = b.get("samples", {}).get(m) or []
            if xs:
                med = statistics.median(xs)
                vals.append(f"{m}={med:.1f}")
                medians.setdefault(f"{b['label']}:{m}", med)
        lines.append(f"{b['label']} b{b.get('block')}: " + ", ".join(vals))
        if b.get("profile"):
            prof = json.dumps(b["profile"], separators=(",", ":"))[:1200]
            lines.append(f"  profile[{b['label']}]: {prof}")
    b_tps, h_tps = medians.get("base:tokens_per_s"), medians.get("head:tokens_per_s")
    if b_tps and h_tps:
        lines.append(f"delta tokens_per_s: {(h_tps / b_tps - 1) * 100:+.1f}%")
    return "\n".join(lines)


def propose_probe(ctx: ToolContext, kind: str, eval_name: str, reason: str,
                  repeats: int | None = None, tokens: int | None = None,
                  order: str | None = None, override: str | None = None,
                  value: float | None = None) -> str:
    params: dict[str, Any] = {"eval": eval_name}
    for k, v in (("repeats", repeats), ("tokens", tokens), ("order", order),
                 ("override", override), ("value", value)):
        if v is not None:
            params[k] = v
    eval_names = [e["name"] for e in ctx.spec.get("evals", [])]
    try:
        clean, est = probes.validate_probe(kind, params, eval_names,
                                           ctx.spec.get("overrides", []))
    except probes.ProbeError as e:
        return f"invalid probe: {e}"
    reject = _budget_reject_reason(ctx, est)
    if reject:
        return f"not run: {reject}"

    pid = f"p{len(ctx.proposals) + 1}"
    prop: dict[str, Any] = {"id": pid, "kind": kind, "params": clean,
                            "reason": reason, "est_gpu_seconds": est,
                            "status": "proposed"}
    ctx.proposals.append(prop)
    append_event(ctx.runs_root, ctx.run_id, "agent", "probe_proposed", dict(prop))

    if ctx.spec.get("approvals") != "auto":
        decision = _wait_approval(ctx, pid)
        if decision != "approved":
            prop["status"] = decision  # denied | expired
            append_event(ctx.runs_root, ctx.run_id, "agent", "probe_" + decision, {"id": pid})
            return (f"probe {pid} not run ({decision}). The proposal stays in the record; "
                    "continue with the evidence you have.")
    prop["status"] = "approved"

    try:
        result = ctx.probe_callback(kind, dict(clean))
    except Exception as e:  # infra failure is an observation, not a crash
        return f"probe {pid} execution failed: {e}"

    ctx.gpu_seconds_used += est
    ctx.experiments_run += 1
    eid = "e" + pid[1:]
    exp_dir = os.path.join(ctx.run_dir, "experiments", eid)
    os.makedirs(exp_dir, exist_ok=True)
    refs = []
    for i, b in enumerate(result):
        rel = os.path.join("experiments", eid, f"b{i}_{b.get('label', '?')}.json")
        with open(os.path.join(ctx.run_dir, rel), "w") as f:
            json.dump(b, f)
        refs.append(rel)
    prop["status"] = "done"
    prop["experiment"] = eid

    summary = _summarize_blocks(result)
    headline = summary.splitlines()[-1] if summary else "no blocks returned"
    append_event(ctx.runs_root, ctx.run_id, "agent", "probe_done",
                 {"id": pid, "experiment": eid, "gpu_seconds": est, "headline": headline},
                 refs=refs)
    return f"probe {pid} done -> experiment {eid} ({est:.0f}s GPU debited)\n{summary}"


def make_tools(ctx: ToolContext) -> list:
    """Function tools for the Agent, closing over one ToolContext."""

    @function_tool
    def read_metrics_tool(experiment: str) -> str:
        """Read the metric JSONs of one experiment. Use "primary" for the main
        paired run's blocks, or an experiment id like "e1" for a probe's.

        Args:
            experiment: "primary" or a probe experiment id ("e1", "e2", ...).
        """
        return read_metrics(ctx, experiment)

    @function_tool
    def search_logs_tool(query: str) -> str:
        """Search retained run logs and event lines for a substring
        (case-insensitive). Returns matching lines with artifact:line refs.

        Args:
            query: substring to look for (e.g. an op name, "error", an eval name).
        """
        return search_logs(ctx, query)

    @function_tool
    def read_log_window_tool(artifact: str, start: int, end: int) -> str:
        """Read a bounded line window of one artifact from the artifact index.

        Args:
            artifact: path relative to the run dir (as listed in the index).
            start: first line, 1-based.
            end: last line (window capped at 200 lines).
        """
        return read_log_window(ctx, artifact, start, end)

    @function_tool
    def propose_probe_tool(kind: str, eval_name: str, reason: str,
                           repeats: int | None = None, tokens: int | None = None,
                           order: str | None = None, override: str | None = None,
                           value: float | None = None) -> str:
        """Propose one follow-up experiment; it executes through the paired
        runner after approval and returns a result summary. Denied or expired
        proposals return "not run" — continue with existing evidence.

        Args:
            kind: "confirm_pair" (repeatability), "profile_pair" (where time
                moved, host vs GPU), or "override_pair" (does the effect
                isolate to a declared config knob).
            eval_name: which declared eval to run.
            reason: what this probe will discriminate between (shown to the approver).
            repeats: samples per block (confirm/override; ceiling applies).
            tokens: token count (confirm optional; profile capture length).
            order: "abba" (default) or "ab" — confirm_pair block order.
            override: declared override name (override_pair only).
            value: value for the override (override_pair only).
        """
        return propose_probe(ctx, kind, eval_name, reason, repeats=repeats,
                             tokens=tokens, order=order, override=override, value=value)

    return [read_metrics_tool, search_logs_tool, read_log_window_tool, propose_probe_tool]
