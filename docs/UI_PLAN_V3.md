# Atlas UI v3 Implementation Plan (agent workspace + density)

> **For agentic workers:** execute task-by-task, in order. The visual spec is
> `v2/wireframes-v3.html` — APPROVED as drawn; its "open decisions" stand as
> the wireframe chose them. UI_PLAN.md's Global Constraints all still apply
> (palette, dots, mono discipline, one primary per page, "Reviews" wording,
> no filler text, build+browser gate per task).

**Goal:** Implement the 11 approved wireframe-v3 screens in `web/`:
the PR/session page, Sandboxes page, telemetry in the trace, the evolved
Evals page, and the density redraw of every existing screen — connected to
the live deployed backend.

**Live API** (`https://atlas-verification--atlas-api.modal.run`), all
verified serving:

- `GET  /api/repos/{name}/sessions` → `SessionSummary[]` (newest first)
- `POST /api/repos/{name}/sessions` `{pr?: number, branch?: string}` → `{session}`
- `GET  /api/sessions/{id}` → `SessionDetail`
- `GET  /api/sessions/{id}/diff` → unified diff, text/plain (404 = none)
- `GET  /api/sessions/{id}/events?since=N` → NDJSON, runs-route cursor parity
- `POST /api/sessions/{id}/messages` `{text}` → `{turn}` (a turn runs 5–10 min)
- `GET  /api/repos/{name}/sandboxes` → `SandboxInfo[]`
- `POST /api/sandboxes/{id}` `{action: "stop"|"extend"}`
- Telemetry per bench block: `GET /api/runs/{id}/artifact?path=blocks/<block>.telemetry.json`
  → `{interval_s, util_gpu[], mem_mb[], power_w[]}` (absent on pre-telemetry
  runs — always degrade silently)

Session event kinds: `user_message thinking agent_message triage env_decision
sandbox_created sandbox_exec sandbox_released test_result review_submitted
eval_draft sandbox_proposed sandbox_denied sandbox_expired turn_done error`.

**Types to add** (`web/lib/types.ts`):

```ts
export interface SessionSummary { session: string; pr: { number: number; title: string; url: string } | null; branch: string | null; created_at: string; status: string }
export interface SessionDetail { session: string; repo: string; pr: { number: number; title: string; url: string; body: string; head: string; base: string } | null; branch: string | null; triage: Annotation[] | null; drafts: EvalDraft[]; status: string }
export interface Annotation { id: string; path: string; start_line: number; end_line: number; risk: "perf" | "correctness" | "memory" | "none"; note: string; coverage: string[] | "gap" }
export interface EvalDraft { id: string; origin: string; name: string; cmd: string; checks: Record<string, string>; est_gpu_seconds: number; status: string }
export interface SandboxInfo { id: string; gpu: string | null; state: "running" | "cooldown" | "terminated"; created_at: string | null; deadline: number | null; attached: { run?: string; session?: string } | null; uptime_s: number | null }
export interface Telemetry { interval_s: number; util_gpu: number[]; mem_mb: number[]; power_w: number[] }
```

`web/lib/api.ts` additions (mock + real for each): `listSessions`,
`createSession`, `getSession`, `getSessionDiff` (text), `getSessionEvents`
(NDJSON parity with `getEvents`), `postSessionMessage`, `listSandboxes`,
`sandboxAction`, `getTelemetry(runId, blockFile)`.

**Routes:** PR/session page at `/repo/[o]/[n]/sessions/[id]`;
`/repo/[o]/[n]/prs/[number]` resolves (listSessions → match pr.number, else
createSession) and redirects to it. Sandboxes at `/repo/[o]/[n]/sandboxes`
(sidebar becomes five items — no standalone Agent entry, per the wireframe).

---

### Task 1 — Data layer + mocks
Types + api.ts above. Mocks: a session mirroring the real smoke (triage with
a1/a2/a3 incl. the `coverage: "gap"` one, drafts, an events feed with every
kind), `sandboxes_nanogpt.json`, telemetry arrays (idle→95% ramp), and the
real `demo/patches/regression.patch` text as the mock diff. Build
green.

### Task 2 — Sandboxes page (wireframe screen 4)
List with StatusDot states (Running blue / Cooldown neutral with countdown
from `deadline` / Terminated faint), GPU, uptime, attached run/session link,
Stop + Keep-warm (+10 min) actions wired to `sandboxAction`, and the
activity feed of `sandbox_exec` events for session-attached boxes.

### Task 3 — Telemetry + phase bars (screen 5)
Trace tab gains: phase-duration bars (from event timestamps) and per-block
GPU-util sparklines from telemetry JSONs (fetch per block, silent absence).
**First: submit one fresh review via the live API** (repo
rohitsandadi/nanoGPT, head fix-sampling, base atlas-base, selection auto,
approvals auto — ~$0.15, authorized) so a real run with telemetry exists to
verify against; poll it while building.

### Task 4 — Evals page evolution (screen 6)
Per-row last-5 delta history (fetch the last ≤5 done runs' verdicts, pick
that eval's tokens_per_s delta; oldest→newest, latest emphasized). Origin
badge ("from PR #N") renders when an eval carries an `origin` field —
mock-mode only today. New-eval dialog reachable from a gap annotation
(prefilled) and from this page.

### Task 5 — The PR/session page (screens 1–3, the hero)
Left: file tree from the diff; unified-diff renderer (parse client-side from
`getSessionDiff`); risk-typed gutter bars where annotations overlap
(path + line range); annotation popover: note, coverage chips or gap +
"Draft eval" (opens the New-eval dialog prefilled from the annotation).
Post-review state: when a `review_submitted` run is done, verdict chips on
the annotated lines (map the run's checks to annotations via coverage).
Right: the session pane — event feed (poll `getSessionEvents`, cursor =
lines received) rendered as the card set from screen 3: thinking lines
(small, muted), triage card, env-decision card, sandbox chips, eval-draft
card (Approve/Deny = optimistic local state; no server route yet — core
feature, mock allowed), test_result, review_submitted (links the review),
error. Composer at the bottom → `postSessionMessage`; while no `turn_done`
has arrived for the latest user_message, show a working indicator (turns run
5–10 min). Branch rows' "Test" button and PR badges route here.

### Task 6 — Density redraw (screens 7–11)
As drawn: Home table + cross-repo feed (card grid retired), Overview 6-stat
strip + sandbox status strip + changes/activity two-column, Branches
sub-lines + Risks column + Test/Review actions, Reviews 10-column table,
review-detail one-band header + verdict/diagnosis two-column. Page width
1240; row padding per the wireframe.

### Task 7 — Live verification
Full sweep in mock mode, then real mode: every page against the live API.
Then ONE live session turn: create/reuse a session on PR #1 and post
"What does this PR change and how should we test it?" — verify thinking
stream, triage card, and cards render as events arrive (start it early in
the task and let it run in the background; ~$0.25 authorized). Leave the dev
server running on :3000 in REAL mode when done.

### Task 8 — Report
Per-task status, files, deviations, unfinished list.
