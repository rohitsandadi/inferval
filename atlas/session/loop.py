"""The session turn: one user message -> triage (first turn with a change
attached) -> the tool loop -> agent_message + turn_done.

Survival rule (mirrors Tier-1): ANY failure inside the turn becomes an
`error` event followed by `turn_done` — the session survives and the next
message starts a fresh turn. Model wiring is identical to the investigator:
env-only configuration, TolerantOutputSchema for ox-alpha's fenced JSON,
generous max_tokens, ceilings enforced in tool callbacks.
"""
import asyncio
import json
import os

from pydantic import BaseModel

from agents import (Agent, AgentOutputSchema, ModelSettings,
                    OpenAIChatCompletionsModel, Runner, set_tracing_disabled)
from openai import AsyncOpenAI

from atlas.contracts import names
from atlas.session import prompts
from atlas.session.context import build_context, chat_dir
from atlas.session.tools import SessionContext, emit, make_tools, release_sandbox

set_tracing_disabled(True)  # no OpenAI key for trace upload

MAX_TOKENS = 16000
DEFAULT_MODEL = "stealth/ox-alpha"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
RISKS = ("perf", "correctness", "memory", "none")


class AnnotationOut(BaseModel):
    id: str
    path: str
    start_line: int
    end_line: int
    risk: str
    note: str
    coverage: list[str] | str


class TriageOut(BaseModel):
    summary: str
    annotations: list[AnnotationOut]


class TolerantOutputSchema(AgentOutputSchema):
    """ox-alpha via OpenRouter ignores response_format and fences its JSON in
    markdown; strip the wrapping before validation (same as investigator)."""

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
        raise RuntimeError("OPENROUTER_API_KEY not set")
    client = AsyncOpenAI(
        base_url=os.environ.get(names.ENV_MODEL_BASE_URL, DEFAULT_BASE_URL),
        api_key=os.environ["OPENROUTER_API_KEY"], timeout=600.0)
    return OpenAIChatCompletionsModel(
        model=os.environ.get(names.ENV_MODEL, DEFAULT_MODEL), openai_client=client)


def _run_agent(agent: Agent, task: str, max_turns: int):
    """The one seam between the loop and the Agents SDK (monkeypatched in
    tests)."""
    return asyncio.run(Runner.run(agent, task, max_turns=max_turns))


def _read_json(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def _find_repo(repo_name: str) -> dict:
    """The repos.json entry for this session's repo, or a minimal stand-in."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "api", "repos.json")
    data = _read_json(path) or {}
    for r in data.get("repos", []):
        if r.get("name") == repo_name:
            return r
    return {"name": repo_name, "evals": [], "overrides": []}


def validate_triage(out: TriageOut, suite_names: list[str]) -> list[dict]:
    """Model output -> contract Annotation[]. Coverage names are validated
    against the declared suite; unknown -> 'gap'. Ids are reassigned a1..aN."""
    anns = []
    for i, a in enumerate(out.annotations):
        cov = a.coverage
        if isinstance(cov, list):
            cov = [n for n in cov if n in suite_names] or "gap"
        elif cov in suite_names:
            cov = [cov]  # a bare eval name string
        else:
            cov = "gap"
        anns.append({"id": f"a{i + 1}", "path": a.path,
                     "start_line": a.start_line, "end_line": a.end_line,
                     "risk": a.risk if a.risk in RISKS else "none",
                     "note": a.note, "coverage": cov})
    return anns


def _run_triage(ctx: SessionContext, max_turns: int) -> None:
    """First structured output of a session with a change attached: annotate
    the diff, write triage.json, emit the triage event."""
    suite_names = [e["name"] for e in ctx.repo.get("evals", [])]
    agent = Agent(name="atlas-triage", instructions=prompts.TRIAGE_PROMPT,
                  model=_model(), model_settings=ModelSettings(max_tokens=MAX_TOKENS),
                  output_type=TolerantOutputSchema(TriageOut, strict_json_schema=False))
    task = build_context(ctx.runs_root, ctx.chat_id, ctx.repo,
                         sandbox_line=ctx.sandbox_line()) + \
        "\n\nTriage this change. Finish with the structured annotation JSON."
    result = _run_agent(agent, task, max_turns)
    out: TriageOut = result.final_output
    anns = validate_triage(out, suite_names)
    with open(os.path.join(ctx.chat_dir, "triage.json"), "w") as f:
        json.dump(anns, f)
    emit(ctx, "agent", "triage", {"summary": out.summary, "annotations": anns})


def run_turn(chat_id: str, runs_root: str, user_text: str, *,
             probe_callback=None, approvals: str = "auto", max_turns: int = 16,
             gpu_seconds_budget: float = 120.0, approval_lookup=None,
             sandbox_factory=None, sandbox_release=None, post_run=None,
             volume=None) -> dict:
    """One chat turn. Returns {"chat", "turn", "ok"}.

    probe_callback(ctx, eval_spec, overrides, out_subdir) -> list[BlockResult]
    backs run_eval (production: the paired runner via the default; tests: a
    mock). All failures after the session dir resolves become an `error`
    event + `turn_done` — the session survives.
    """
    d = chat_dir(runs_root, chat_id)
    meta = _read_json(os.path.join(d, "meta.json"))
    if meta is None:
        raise ValueError(f"unknown session {chat_id} (no meta.json under {d})")
    events_path = os.path.join(d, "events.jsonl")
    turn = 1
    try:
        with open(events_path) as f:
            for line in f:
                try:
                    if json.loads(line).get("kind") == "user_message":
                        turn += 1
                except ValueError:
                    continue
    except FileNotFoundError:
        pass

    repo = _find_repo(meta.get("repo", ""))
    ctx = SessionContext(chat_id=chat_id, runs_root=runs_root, repo=repo,
                         meta=meta, approvals=approvals,
                         approval_lookup=approval_lookup,
                         gpu_seconds_budget=gpu_seconds_budget,
                         sandbox_factory=sandbox_factory,
                         sandbox_release=sandbox_release,
                         eval_runner=probe_callback, post_run=post_run,
                         volume=volume)
    emit(ctx, "human", "user_message", {"text": user_text, "turn": turn})

    ok = True
    try:
        has_change = bool(meta.get("pr") or meta.get("branch"))
        has_diff = os.path.isfile(os.path.join(d, "pr.diff"))
        if has_change and has_diff and not os.path.isfile(
                os.path.join(d, "triage.json")):
            try:
                _run_triage(ctx, max_turns=4)
            except Exception as e:  # triage dying must not kill the turn
                emit(ctx, "system", "error",
                     {"error": f"triage failed: {e}"[:2000], "turn": turn})

        agent = Agent(name="atlas-session", instructions=prompts.SYSTEM_PROMPT,
                      model=_model(),
                      model_settings=ModelSettings(max_tokens=MAX_TOKENS),
                      tools=make_tools(ctx))
        task = build_context(runs_root, chat_id, repo,
                             sandbox_line=ctx.sandbox_line()) + \
            f"\n\n## User message\n{user_text}\n\nAct on this message with " \
            "your tools, then reply."
        # max_turns counts ACTIONS; the set_status-before-every-call pattern
        # spends one extra model invocation per action, hence * 2.
        result = _run_agent(agent, task, max_turns * 2)
        text = result.final_output if isinstance(result.final_output, str) \
            else str(result.final_output)
        emit(ctx, "agent", "agent_message", {"text": text, "turn": turn})
    except Exception as e:  # the session survives; the error is an event
        ok = False
        emit(ctx, "system", "error", {"error": str(e)[:2000], "turn": turn})
    finally:
        release_sandbox(ctx)
        try:
            meta["status"] = "active"
            with open(os.path.join(d, "meta.json"), "w") as f:
                json.dump(meta, f)
        except OSError:
            pass
        emit(ctx, "system", "turn_done", {"turn": turn, "ok": ok})
    return {"chat": chat_id, "turn": turn, "ok": ok}
