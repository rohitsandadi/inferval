# Atlas PRD

One page. What we're building, for whom, and what done looks like. Details
live in the linked docs — this is the map.

## Problem

Coding agents write performance-critical inference code and claim things
like "2x faster." Tests check logic, not behavior on hardware, so these
claims merge unmeasured. When someone does catch a regression, finding out
why (noise? GPU compute? host-side stall?) is manual work: rerun, read logs,
profile, repeat.

## Product

Atlas — evals and verification for agent-written inference code.

Think pytest, for inference behavior. A repo declares a suite of evals in
`atlas.yaml` (scenarios + checks) — written by a human, or drafted by the
agent and approved. When a change lands, an agent reads the
diff and its claims and plans the run: which evals matter, what extra
metrics to collect beyond the always-on base set (latency, throughput, peak
VRAM, correctness). The evals run as controlled experiments on Modal GPUs —
paired base-vs-candidate for PRs (compare mode), or one revision against
absolute checks (check mode). A deterministic policy issues verdicts, and
the same agent investigates regressions with follow-up experiments.
Everything ends in one report: verdicts, highlighted violations, findings
summary, diagnosis, evidence links. The fix-context JSON goes back to a
coding agent, which fixes and re-verifies.

## Users

- Teams letting coding agents (Codex, Claude Code) touch inference repos.
- Anyone deciding whether to trust a performance PR.
- The judges' 3-minute version: an agent claims 2x faster → Atlas proves it's
  22% slower → shows why → the fix goes green.

## Core flows

1. **Verify a change (compare mode):** PR or branch pair → agent plans the
   run from the diff + claims → relevant evals run paired on one GPU →
   verdicts + investigation → report.
2. **Run the suite (check mode):** one revision → declared evals against
   absolute checks — like running tests. On demand, on main, or nightly.
3. **Browse state:** repos list → repo detail (suite, branches/PRs, run
   history with metric deltas) → run detail.
4. **Close the loop:** report's fix-context → coding agent → new commit →
   re-verify → green. PR comment (with optional `@greptileai` ping) carries
   the same report.

## System in one paragraph

Next.js + shadcn UI (local) → FastAPI JSON API on Modal → controller
function (spawned per run) → agent (OpenAI Agents SDK) plans the run from
the diff and claims (which evals, which extra metrics) → GPU sandbox
(pinned image, no creds, no network) executes the planned evals — both
revisions interleaved in compare mode → metrics land on a Volume →
comparator issues pass/regression/invalid per check → on regression, the
same agent investigates: it proposes follow-up experiments (confirm /
paired profile / declared override) which run on user approval — or
instantly with auto-approve on — within GPU/turn ceilings → report
rendered → sandbox terminated. Verdicts are never LLM outputs, and the run
completes even if the agent fails (falling back to the full declared suite
with base metrics).

## Hackathon done = 

- nanoGPT fork with a 2–3 eval suite, verified end to end: agent's run plan
  visible in the trace, false-claim PR caught, probe localizes the cause,
  fix re-verified green, plus one passing PR.
- The three UI pages work; the run detail page replays the hero run.
- Demo under 3:00, rehearsed twice, video backup captured.

Non-goals for the event: GitHub App, real multi-repo integration, MCP
(stretch), auth, kernel writing (we verify, never write), the 1980s report
theme (later polish).

## Key decisions (settled)

| Decision | Choice |
| --- | --- |
| Demo repo | nanoGPT fork (adapts its own bench.py/sample.py) |
| Investigator harness | OpenAI Agents SDK (typed tools, built-in loop, structured output), model via OpenRouter (`ox-alpha`, free preview; env-swappable fallback) |
| UI | Next.js + shadcn/ui + Tailwind, local for demo |
| Backend | Everything on Modal: controller, sandbox, Volume, JSON API |
| Verdict | Deterministic policy; agent explains, never grades |
| Human role | Reads the report; flagged items are highlights, not a workflow |

## Doc map

- [README.md](README.md) — positioning, pitch, why-now.
- [ARCHITECTURE.md](ARCHITECTURE.md) — tiers, contracts, lifecycle, Modal
  map, UI spec.
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — modules M0–M5, tech choices,
  interfaces, inline reviews.
- [BUILD_PLAN.md](BUILD_PLAN.md) — tonight's checklist, work packets,
  timeline, scope ladder, risks.
- [DEMO.md](DEMO.md) — nanoGPT scenario, 3-minute script, Q&A.
- [REFERENCES.md](REFERENCES.md) — proven code to build from, per module.
- `../old/` — v1 (GPUGate) docs, superseded but kept.
