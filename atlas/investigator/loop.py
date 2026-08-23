"""Agents SDK wiring: the run planner and the investigation loop.

Model comes from env only (names.ENV_MODEL / ENV_MODEL_BASE_URL) — the
fallback plan for event day is swapping two env vars, zero code. ox-alpha is
a reasoning model: it spends output tokens thinking before content, so
max_tokens must stay generous.

Any model/API failure — including MaxTurnsExceeded — raises
InvestigatorFailed. The controller catches it and publishes
diagnosis: inconclusive; the deterministic verdict never depends on this
module surviving.
"""
import asyncio
import os
from typing import Literal

from pydantic import BaseModel

from agents import (Agent, AgentOutputSchema, ModelSettings,
                    OpenAIChatCompletionsModel, Runner, set_tracing_disabled)
from openai import AsyncOpenAI

from atlas.contracts import names
from atlas.contracts.validate import validate
from atlas.investigator import prompts
from atlas.investigator.context import build_context
from atlas.investigator.tools import ToolContext, make_tools
from atlas.referee.events import append_event

set_tracing_disabled(True)  # no OpenAI key for trace upload

MAX_TOKENS = 16000
DEFAULT_MODEL = "stealth/ox-alpha"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"


class InvestigatorFailed(Exception):
    """Tier-2 died; Tier-1 must still publish (diagnosis: inconclusive)."""


class ObservationOut(BaseModel):
    id: str
    text: str
    refs: list[str]


class HypothesisOut(BaseModel):
    id: str
    text: str
    status: Literal["supported", "rejected", "inconclusive"]
    refs: list[str]


class DiagnosisOut(BaseModel):
    text: str
    confidence: Literal["low", "medium", "high"]


class FixContextOut(BaseModel):
    base: str
    cand: str
    suspect_paths: list[str]
    evidence: list[str]
    success_condition: str


class InvestigationOut(BaseModel):
    status: Literal["completed", "inconclusive"]
    observations: list[ObservationOut]
    hypotheses: list[HypothesisOut]
    diagnosis: DiagnosisOut
    fix_context: FixContextOut


class RunPlanOut(BaseModel):
    evals: list[str]
    extra_metrics: list[str]
    reasoning: str


class TolerantOutputSchema(AgentOutputSchema):
    """ox-alpha via OpenRouter ignores response_format and fences its JSON in
    markdown; strip the wrapping before validation. The shape itself is pinned
    by the prompt (see prompts.py)."""

    def validate_json(self, json_str: str):
        s = json_str.strip()
        if s.startswith("```"):
            s = s.split("\n", 1)[1] if "\n" in s else s[3:]
            s = s.rsplit("```", 1)[0]
        if not s.lstrip().startswith("{") and "{" in s and "}" in s:
            s = s[s.index("{"):s.rindex("}") + 1]
        return super().validate_json(s)


def _model() -> OpenAIChatCompletionsModel:
    if "OPENROUTER_API_KEY" not in os.environ:
        raise InvestigatorFailed("OPENROUTER_API_KEY not set")
    client = AsyncOpenAI(
        base_url=os.environ.get(names.ENV_MODEL_BASE_URL, DEFAULT_BASE_URL),
        api_key=os.environ["OPENROUTER_API_KEY"], timeout=600.0)
    return OpenAIChatCompletionsModel(
        model=os.environ.get(names.ENV_MODEL, DEFAULT_MODEL), openai_client=client)


def plan(spec: dict, diff_text: str) -> dict:
    """Cheap single call before GPU work: pick evals + extra metrics from the
    diff and claim. Controller falls back to the full suite on failure."""
    suite = [e["name"] for e in spec.get("evals", [])]
    lines = ["## Declared suite"]
    lines += [f"- {e['name']}: `{e['cmd']}` checks {e.get('checks', {})}"
              for e in spec.get("evals", [])]
    if spec.get("claim"):
        lines += ["", "## PR claim", spec["claim"]]
    lines += ["", "## Diff", diff_text[:6000]]
    agent = Agent(name="atlas-planner", instructions=prompts.PLAN_PROMPT,
                  model=_model(), model_settings=ModelSettings(max_tokens=MAX_TOKENS),
                  output_type=TolerantOutputSchema(RunPlanOut, strict_json_schema=False))
    try:
        result = asyncio.run(Runner.run(agent, "\n".join(lines), max_turns=2))
        out: RunPlanOut = result.final_output
    except Exception as e:
        raise InvestigatorFailed(f"plan call failed: {e}") from e
    evals = [e for e in out.evals if e in suite] or suite
    return {"evals": evals, "extra_metrics": out.extra_metrics, "reasoning": out.reasoning}


def investigate(run_id: str, runs_root: str, spec: dict, verdict: dict,
                probe_callback, approval_lookup, *,
                max_experiments: int = 3, gpu_seconds_budget: float = 240.0,
                approval_timeout_s: float = 1800.0, poll_interval_s: float = 2.0,
                max_turns: int = 12, hooks=None) -> dict:
    """Run the Tier-2 investigation; return an Investigation dict.

    probe_callback(kind, params) -> list[BlockResult]; approval_lookup(key)
    -> "approved"|"denied"|None (see tools.py docstring for wiring).
    """
    ctx = ToolContext(run_id=run_id, runs_root=runs_root, spec=spec,
                      probe_callback=probe_callback, approval_lookup=approval_lookup,
                      max_experiments=max_experiments,
                      gpu_seconds_budget=gpu_seconds_budget,
                      approval_timeout_s=approval_timeout_s,
                      poll_interval_s=poll_interval_s)
    agent = Agent(name="atlas-investigator", instructions=prompts.SYSTEM_PROMPT,
                  model=_model(), model_settings=ModelSettings(max_tokens=MAX_TOKENS),
                  tools=make_tools(ctx),
                  output_type=TolerantOutputSchema(InvestigationOut, strict_json_schema=False))
    task = build_context(run_id, runs_root) + \
        "\n\nInvestigate this run. Finish with the structured conclusion."
    try:
        result = asyncio.run(Runner.run(agent, task, max_turns=max_turns, hooks=hooks))
        out: InvestigationOut = result.final_output
    except Exception as e:
        raise InvestigatorFailed(f"investigation failed: {e}") from e

    inv = {"schema": "1", "run": run_id, "status": out.status,
           "observations": [o.model_dump() for o in out.observations],
           "hypotheses": [h.model_dump() for h in out.hypotheses],
           "proposals": ctx.proposals,
           "diagnosis": out.diagnosis.model_dump(),
           "fix_context": out.fix_context.model_dump()}
    validate(inv, "investigation")
    for o in inv["observations"]:
        append_event(runs_root, run_id, "agent", "observation",
                     {"id": o["id"], "text": o["text"]}, refs=o["refs"])
    for h in inv["hypotheses"]:
        append_event(runs_root, run_id, "agent", "hypothesis",
                     {"id": h["id"], "text": h["text"], "status": h["status"]})
    append_event(runs_root, run_id, "agent", "conclusion",
                 {"diagnosis": inv["diagnosis"]["text"],
                  "confidence": inv["diagnosis"]["confidence"], "status": inv["status"]})
    return inv
