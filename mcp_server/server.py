"""Inferval MCP server — the door for the user's own coding agent.

Runs locally over stdio next to the agent; every tool is one HTTP call to
the deployed API (INFERVAL_API env, default the production URL). This is
how an agent learns the platform (get_started), defines a repo's evals,
kicks off reviews, and reads verdicts.

Run:  .venv/bin/python mcp_server/server.py
"""
import json
import os

import httpx
from mcp.server import MCPServer

API = os.environ.get("INFERVAL_API",
                     "https://atlas-verification--atlas-api.modal.run")

GUIDE = """\
Inferval verifies performance/behavior claims about inference code on real
GPUs. Core ideas:

- A repo has EVALS: named measurement recipes. Each eval = a bench command
  plus limits it must hold. Metrics: tokens_per_s, latency_ms_median,
  latency_ms_p95, peak_vram_mb.
- Two kinds of limits. checks (compare mode, old-vs-new): "tokens_per_s":
  "-10%" means the new code may not be more than 10% slower; "+15%" on a
  latency metric means it may not be more than 15% higher. absolute (check
  mode, single version): "latency_ms_p95": "<3000".
- A REVIEW runs evals as a paired experiment (base, head, head, base on one
  GPU, fresh process per block); a pure-code referee issues the verdict
  (pass / regression / invalid) — no model in the verdict. On regression an
  investigator agent diagnoses why. Output: a report + PR comment.
- Eval cmd template placeholders: {src} = the checked-out revision's path,
  {out} = where the bench must write its metrics JSON. Demo-repo example:
  "python /harness/bench.py --src {src} --eval generate_short --tokens 128
  --batch 2 --repeats 5 --out {out}".

Typical agent flow: connect_repo -> study the repo -> create_eval for each
scenario worth guarding (start with 2-3: a short and a long/heavier one;
thresholds ~3-5x the measurement noise, e.g. -10% tokens_per_s) ->
submit_review on a change -> get_run until done -> get_report.
"""

server = MCPServer(
    name="inferval",
    instructions="Evals and verification for inference code on real GPUs. "
                 "Call get_started first for the concepts and eval format.")


def _get(path: str):
    r = httpx.get(f"{API}{path}", timeout=30)
    r.raise_for_status()
    return r.json()


def _post(path: str, body: dict):
    r = httpx.post(f"{API}{path}", json=body, timeout=60)
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except ValueError:
            detail = r.text
        raise RuntimeError(f"{r.status_code}: {detail}")
    return r.json()


@server.tool()
def get_started() -> str:
    """How Inferval works and how to write evals. Read this first."""
    return GUIDE


@server.tool()
def list_repos() -> str:
    """Connected repos with their eval names and review counts."""
    rows = [{"name": r["name"], "evals": r["evals"],
             "reviews": r.get("runs_count", 0)} for r in _get("/api/repos")]
    return json.dumps(rows, indent=1)


@server.tool()
def connect_repo(name: str) -> str:
    """Connect a public GitHub repo by owner/repo name."""
    return json.dumps(_post("/api/repos", {"name": name}), indent=1)


@server.tool()
def list_evals(repo: str) -> str:
    """Full eval definitions stored for a repo (created via create_eval)."""
    return json.dumps(_get(f"/api/repos/{repo}/evals"), indent=1)


@server.tool()
def create_eval(repo: str, name: str, cmd: str, checks: dict,
                absolute: dict | None = None) -> str:
    """Create or replace one eval. See get_started for cmd placeholders and
    threshold formats. checks example: {"tokens_per_s": "-10%",
    "latency_ms_p95": "+15%"}; absolute example: {"latency_ms_p95": "<3000"}."""
    body = {"name": name, "cmd": cmd, "checks": checks}
    if absolute:
        body["absolute"] = absolute
    return json.dumps(_post(f"/api/repos/{repo}/evals", body), indent=1)


@server.tool()
def submit_review(repo: str, base: str, head: str | None = None,
                  mode: str = "compare", evals: list[str] | None = None,
                  claim: str | None = None) -> str:
    """Start a review. compare mode needs base and head (branch or SHA);
    check mode measures base alone against absolute limits. evals: names to
    run (omit = the agent-planned selection). claim: what the change says
    it does — the verdict checks it. Returns the run id."""
    body: dict = {"repo": repo, "mode": mode, "base_sha": base,
                  "selection": "pick" if evals else "auto",
                  "approvals": "auto"}
    if head:
        body["head_sha"] = head
        body["branch"] = head
    if evals:
        body["evals"] = evals
    if claim:
        body["claim"] = claim
    return json.dumps(_post("/api/runs", body), indent=1)


@server.tool()
def get_run(run_id: str) -> str:
    """Status + verdict for a review. Poll until status is 'done'
    (a review takes 3-15 minutes)."""
    d = _get(f"/api/runs/{run_id}")
    v = d.get("verdict") or {}
    return json.dumps({"run": run_id, "status": d.get("status"),
                       "verdict": v.get("verdict"),
                       "checks": v.get("checks"),
                       "cost_usd": d.get("cost_usd")}, indent=1)


@server.tool()
def get_report(run_id: str) -> str:
    """The finished review's report: findings, diagnosis, PR comment."""
    d = _get(f"/api/runs/{run_id}/report")
    return json.dumps({"summary": d.get("summary"),
                       "flagged": d.get("flagged"),
                       "pr_comment_md": d.get("pr_comment_md")}, indent=1)


if __name__ == "__main__":
    server.run()
