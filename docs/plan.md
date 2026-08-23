# Reconnection plan

Why this document: the pieces were built faster than the connections between
them. This plan fixes the connections first, then splits the work. Nothing
below gets coded until it's signed off.

The system in one sentence: **Inferval watches a repo's changes and verifies
their claims on real GPUs — using the repo's saved evals when they exist,
inventing a constrained scoped eval when they don't — while the user's own
coding agent writes and maintains the eval suite through the MCP server.**

## The map — how everything connects

The **eval store** is the center. One list of evals per repo, saved on the
platform's storage (same place as runs — that's why every browser sees the
same data; there is no separate database).

Writers into the store:
- the repo's own yaml file (imported at connect; renamed `inferval.yaml`
  in a later wave),
- the user's coding agent, through the MCP server,
- the Evals page form,
- the PR agent's scoped evals, when the user chooses to keep one.

Readers of the store:
- every review (the plan step narrows *from the store*),
- the PR agent's coverage check ("is this claim covered?"),
- the UI.

One measurement engine: everything that produces a verdict — saved evals
and scoped ones alike — goes through the same paired run and the same
pure-code referee. No second path.

## Part A — eval store · SHIPPED, two follow-ups

Live already: create/list/delete per repo, saved evals overlay the seeded
suite, reviews on an empty suite get a clear error instead of the
"latency < 3s and nothing else" surprise.

Follow-ups: (1) the Evals-page form saves through it (today it only
remembers in the browser); (2) on repo connect, import the repo's yaml into
the store so there's exactly one source of truth afterwards.

## Part B — MCP server, hosted on Vercel

Simplest possible connection for any user: the MCP server is a route inside
the web app we already deploy — Vercel's `mcp-handler` package makes an
App-Router route an MCP server over streamable HTTP. Users connect with a
URL, nothing to install:

- Claude Code: `claude mcp add -t http inferval https://inferval.vercel.app/api/mcp`
- Cursor / Codex-style configs: `{"url": "https://inferval.vercel.app/api/mcp"}`
- A Claude Code plugin later is a thin wrapper around that URL; a Codex
  snippet goes in the README. Low effort, not on the critical path.

Tools (each one HTTP call to the Modal API, zero logic in the MCP layer):
`get_started` (the full "what Inferval is and how to write evals" guide —
this is how a connected agent learns the platform), `list_repos`,
`connect_repo`, `list_evals`, `create_eval`, `submit_review`, `get_run`,
`get_report`. These are already written and tested as a local Python server;
the work is porting them into the Next route and deleting the Python one so
there's a single MCP.

## Part C — the background PR agent · constrained, no chat

The chat window goes away. The agent is a worker that runs when asked (a
"Review this PR" button first; automatic polling of new PRs as the optional
follow-up), and its output is artifacts on the PR page, not a conversation.

Per PR, in order:
1. Pull the PR and its changes through the GitHub connection.
2. Highlight the risky parts of the diff (this exists and is proven).
3. Coverage decision: which saved evals touch this change; is any claim in
   the PR uncovered?
4. For an uncovered claim, propose **one scoped eval — tightly constrained**:
   - it may only parameterize a **declared measurement harness** (the bench
     entry the repo declares; for the demo, nanoGPT's bench) — picking
     scenario knobs like tokens, batch, repeats, and which metrics to bound;
   - knobs and thresholds are validated against hard ceilings (max repeats,
     max tokens, sane threshold ranges) — the same ceiling pattern the
     investigator's probes already use;
   - it is the **same schema as any saved eval** and passes the same store
     validation. The agent cannot invent arbitrary commands for a verdict.
5. Run the selected saved evals plus the scoped one through the normal
   pipeline → pure-code verdict → report and PR comment. The scoped eval is
   labeled "proposed for this PR"; one click keeps it in the store,
   otherwise it expires with the run.
6. The old safety rule stands: if the agent fails at any step, the review
   still ships with whatever was declared.

Demo fit (the anchor): on the nanoGPT fork's PR #1, the scoped eval is the
kind the live test already drafted on its own — a seeded output-equivalence
check or a short-context sampling micro-bench, parameterized from the
existing bench script. Nothing hardcoded to nanoGPT: any repo that declares
a harness gets the same behavior; nanoGPT is simply the repo we demo.

## Part D — UI, in the new house style

All new UI follows the conventions that just landed: data through the
TanStack Query hooks in `lib/queries.ts` (components never call the API
layer directly), Inferval naming and brand mark, the redesigned pipeline
progress and unified topbars. Changes: PR page renders the worker's
artifacts (highlights → decision → results) as cards; chat composer
removed; New-eval form persists; Evals page shows store evals with origin
badges ("from PR #1").

## Part E — scope guards

Not doing: arbitrary shell in anything verdict-bearing; GitHub webhooks or
a GitHub App (manual button + optional polling only); auth; renaming code
identifiers (`atlas` module, Modal app) — the `inferval.yaml` rename is its
own small wave at the end; anything that doesn't demo on the nanoGPT fork.

## Build split (starts only after sign-off)

1. **MCP route on Vercel** — port the 8 tools, delete the Python server,
   README connection snippets. Small, independent.
2. **Scoped-eval proposer** — the constraint layer (harness-parameterizing
   proposal + ceiling validation) wired into the review pipeline, plus the
   "Review this PR" trigger. The meaty packet.
3. **UI packet** — New-eval persistence now (independent), PR-page worker
   cards after packet 2 defines their data.
4. **Optional wave** — PR polling watcher; `inferval.yaml` rename + import.

Order: 1 and the first half of 3 run in parallel; 2 then the rest of 3;
4 last. Every packet ends with a check on the nanoGPT demo and one gated
deploy.

## Open questions

- Scoped eval on a PR: run automatically once proposed, or show the
  proposal card and wait for a click the first time?
- Delete the Python MCP server outright, or keep it as a local-dev option?
- Auto-polling of new PRs in this wave or the next?
