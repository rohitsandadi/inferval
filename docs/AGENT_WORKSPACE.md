# Agent workspace (v3 direction)

Source: Greptile engineer feedback, 2026-08-23. Status: architecture only — no
code yet. Companion to ARCHITECTURE.md (the two-tier machinery this composes).

## What the feedback adds up to

Today Atlas is a pipeline you submit to: pick refs → the run happens → read
the result. The feedback asks for a workspace you talk to: attach a PR, say
"test this", watch the agent triage the change, decide what hardware it
actually needs, spin up sandboxes as tools, run only what the change touches,
and escalate to a formal verdict when it matters — with its thinking visible
the whole way.

The core claim of this doc: **that is a new surface, not a new system.** The
agent harness (investigator), the approval mechanic (proposals), the visible
reasoning stream (tier-labeled events), and the sandbox lifecycle all exist
and are live-proven. What's new is one concept and a generalized toolset.

## The one new concept: the repo agent session

A **session** is a conversation between the user and the repo's agent,
attached to a change (a PR or branch). It is stored and served exactly like a
run: `chats/<chat_id>/events.jsonl` on the runs volume, same Event contract,
same polling endpoint pattern, same tier labels. The chat pane is a re-skin of
the trace component over a live feed.

New event kinds (open enum, so nothing downstream breaks):
`user_message`, `agent_message`, `thinking`, `triage`, `env_decision`,
`sandbox_created`, `sandbox_exec`, `sandbox_released`, `test_result`,
`review_submitted`.

Backend: one Modal function `chat_turn(chat_id, message)` spawned per user
turn (same pattern as `run_controller`). The agent inside is the investigator
harness (Agents SDK, TolerantOutputSchema, ceilings-in-callbacks) with a
session prompt and a bigger toolset.

## The flow, concretely ("I want to test this PR")

1. **Attach.** User opens the repo's Agent tab (or "Test this change" on a
   branch/PR page, which pre-attaches). Attaching a PR fetches title, body,
   diff, and commits from the GitHub REST API and renders a PR card.
2. **Triage (visible).** The agent's first structured output is a triage
   card, rendered as its own block: files touched → subsystems affected →
   behavioral risk ("sampling path in `model.py:generate` — per-token
   latency risk") → what deserves testing → what doesn't.
3. **Environment decision (visible).** The agent picks from an allowlist:
   `none` (answerable from the diff), `cpu` (imports, unit-level checks,
   small kernels), or a GPU type (`T4 | A10G | A100`), each with an estimated
   cost. The decision and its one-line reason render as a card. This is the
   "don't allocate a GPU for a docs change" beat — imperfect is fine, the
   reasoning being visible is the feature.
4. **Approval.** Sandbox creation with cost reuses the existing proposal
   card + approvals Dict mechanic. `approvals: auto` skips the wait —
   unchanged code path.
5. **Sandbox as a tool.** The agent creates the sandbox and works in it.
   Every exec is an event → the sandbox activity feed (the Sandboxes view
   shows the same feed). Scoped tests = commands the agent writes (run the
   one kernel, pytest -k, a 30-second micro-bench) — evidence, not verdicts.
6. **Escalation to a formal review.** When the change deserves a verdict,
   the agent calls `submit_review` — the existing controller, unchanged.
   The chat links the review page; the verdict remains a policy decision.
7. **Report.** The agent summarizes with links to every artifact it produced.

## Tools for the session agent

| Tool | Backed by | Ceiling |
| --- | --- | --- |
| `read_pr(number)` / `read_diff(base, head)` | GitHub REST (public; token secret optional) | size-capped |
| `read_repo_file(path, ref)` | shallow clone in the sandbox, or raw.githubusercontent | bytes cap |
| `decide_environment()` | structured output, rendered as a card | allowlist `{none, cpu, T4, A10G, A100}` |
| `create_sandbox(kind)` | `sandbox_mgr` (exists) | max 1 live per session, TTL, budget ledger |
| `exec(cmd)` | `sandbox.exec` (exists) | output cap, network stays blocked |
| `run_eval(name, params)` | `run_blocks` paired runner (exists — probes already use it) | declared evals + override whitelist |
| `submit_review(base, head, evals?)` | `POST /api/runs` (exists) | one per session turn |
| `set_status(text)` | one-sentence reasoning before each tool call → `thinking` events | — |

The `set_status` pattern is lifted from Modal's own Agents-SDK example: the
model states its reasoning before each action, and that stream is what the UI
renders as "the agent thinking." No new model capability required.

## The trust boundary (unchanged, and worth saying out loud)

Chat-agent output is **evidence, labeled agent-tier**. Verdicts still come
only from the deterministic pipeline over declared evals. The session can
gather anything; it can prove things only by escalating to a review. This
keeps the product's core answer intact: the agent proposes, hardware and
policy decide.

## The PR page: the change lives inside Atlas

"Attach a PR" is not a chip on a branch row — it is a page. Layout: the diff
on the left, the agent session on the right, one shared context.

**Left pane — the diff, annotated.** File tree + rendered patches (unified
diff fetched from GitHub; we already carry diff text in run specs). After
triage, the agent's findings anchor to file + line ranges as gutter
highlights, like review comments but about runtime risk:

> `model.py` lines 341–353 — sampling moved to host: per-token DtoH transfer
> + `.item()` sync in the hot loop. **Perf-critical.** Covered by:
> `generate_short`, `generate_long`.

Each annotation carries a risk type (perf / correctness / memory / neutral),
a one-line why, and — the load-bearing part — its **coverage**: which evals
exercise this code path, or "no eval covers this" (a gap).

**Right pane — the session**, scoped to this PR. Clicking an annotation asks
the agent about it; agent messages reference annotations by anchor. Triage,
environment, and eval-draft cards render inline here.

### The annotation → eval → evidence chain

This is what connects eval creation to PRs instead of leaving the suite as
static config:

1. **Triage annotates** the diff (structured output: `Annotation[]`).
2. **Coverage mapping**: every annotation resolves to covering evals or a gap.
3. **Gap → eval draft.** On a gap, the agent drafts an eval in response to a
   real detected need — name, command, checks, estimated cost — rendered as a
   card ("no eval isolates sampling-step latency — draft `sample_step`, ~20s
   on A10G"). Approve → it joins the suite. This is where "Suggest evals"
   belongs: not a button, a response to a gap on a real change.
4. **The run plan is justified**, not asserted: selected evals each trace
   back to the annotation that demanded them. The plan card shows the chain.
5. **Results land back on the diff.** After the review, annotation anchors
   get verdict chips inline — the highlighted region in `model.py` reads
   "● Regression −33.9% tokens/s (generate_short)" at the exact lines that
   caused it. The diagnosis and `fix_context.suspect_paths` use the same
   anchors from the other direction.
6. **Posting is line-anchored.** GitHub's PR review API takes per-line
   comments: the Atlas verdict can land *on the lines* as a review, with the
   summary (and the optional @greptileai ping) in the review body — instead
   of one comment blob.

The consequence for evals: **the suite is grown by traffic.** Evals are born
when a PR exposes a coverage gap, get human-approved, and accumulate —
exactly how a pytest suite actually grows (a bug reveals a missing test; the
test outlives the bug). "Define your suite up front" becomes just the seed.

### PR lifecycle states

Attached → Triaged → Planned → Verified → Diagnosed (if red) → Fixed
(re-verified green) → Reported (posted). The six-verb lifecycle, PR-anchored;
the PR page header shows this chain, and the branch timeline nests under it.

### New data shapes

```json
// triage.json — Annotation
{"id": "a1", "path": "model.py", "start_line": 341, "end_line": 353,
 "risk": "perf", "note": "per-token DtoH + sync in generate loop",
 "coverage": ["generate_short", "generate_long"]}   // or "coverage": "gap"

// EvalDraft — the approval mechanic reused
{"id": "d1", "origin": "a2", "name": "sample_step",
 "cmd": "…bench.py --eval sample_step …", "checks": {"latency_ms_p95": "+15%"},
 "est_gpu_seconds": 20, "status": "proposed"}
```

Both stored in the session dir, served by the same API patterns, rendered by
the same card components as proposals.

## GitHub, properly attached

- PR attach via REST (no auth needed for public repos; a `github-token`
  Modal secret upgrades rate limits and enables private repos + comment
  posting). Rendered as our own PR card — GitHub has no official embeds.
- Branch/PR facts move from static `repos.json` seeds to live fetch (the
  previously-deferred stretch — now justified because the session needs the
  same API anyway). repos.json stays as the fallback.
- The report's PR comment goes from "rendered artifact" to actually posted
  via the token — the output door closes the loop for real.

## Where it lives in the UI

- Repo sidebar gains **Agent** — the session pane: messages, thinking lines
  (collapsed by default, expandable), triage/environment/proposal cards
  inline, sandbox activity chips, links out to reviews it started.
- Branch and PR pages get "Test this change" → opens Agent with the change
  attached.
- The Sandboxes view (from the earlier brainstorm) lists every live/cooldown
  sandbox — session-created ones included — with the activity feed, Stop,
  and keep-warm controls. Chat and Sandboxes are two windows onto the same
  events.

## Build cut (when we decide to build)

- **MVP (one focused day):** the PR page (diff render + annotation gutter +
  session pane) + session storage + `chat_turn` + the toolset minus
  `read_repo_file`; triage/env/eval-draft cards; CPU/GPU sandbox creation
  behind proposal cards; results-on-diff chips; Sandboxes view.
- **MVP-of-the-MVP (half day):** triage annotations + coverage/gap mapping +
  eval-draft card on the existing branch page, without the full diff render —
  the chain exists, the diff view comes next.
- **Mention-only at first:** fine-grained CPU-vs-GPU judgment quality (the
  option existing is the feature), private repos, multi-sandbox sessions.
- **Post-event:** live branch sync everywhere, line-anchored PR review
  posting, the pytest-decorator eval DSL (the session agent is the natural
  author of those eval files — a gap-born draft becomes a committed
  `@atlas.eval` function).

## The loop, end to end (the comprehensive story)

Agent opens PR → Atlas attaches it → triage annotates the diff → coverage map
shows two covered risks and one gap → agent drafts the missing eval → human
approves → scoped review runs (the covering evals + the new one, on the
hardware the agent justified, cost shown) → regression verdict → the diff
lights up red at the exact lines → the investigation's diagnosis cites the
same anchors → fix_context → the coding agent pushes the fix → green
re-verify → line-anchored review posted to GitHub → merge. The suite
permanently gained `sample_step`.

That chain — code location ↔ eval ↔ hardware evidence ↔ PR state — is also
the sharpest answer to "why not just tell Claude Code to do this": a chat
doesn't accumulate a system of record; this does.

## Open decisions

1. ~~Session scope~~ **Resolved by the PR-page design: one session per
   attached change.** The PR page and its session are the same context.
2. GitHub token as a Modal secret now (enables line-anchored posting + rate
   headroom) or public-API-only?
3. Default budget per session (GPU-seconds and max sandboxes) — same ledger
   pattern as probes, needs numbers.
4. Does this land before the event (it would replace demo-asset time) or is
   it the roadmap slide with the MVP built after?
