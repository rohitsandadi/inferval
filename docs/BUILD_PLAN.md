# Atlas Build Plan (v2)

Ground rules: **all code is written by coding agents.** Humans write specs,
review output, run validations against real infra, and integrate. Code freeze
at **4:30 PM**; 4:30–5:00 is demo assembly and rehearsal, not development.

## 1. Tonight / pre-event checklist (the un-delegatable work)

Agents cannot scaffold knowledge about real infrastructure. Buy it tonight:

- [x] Modal account, credits, workspace confirmed; `modal` SDK version pinned.
- [x] nanoGPT image built/pushed (torch + nanoGPT deps) and **cached on Modal**.
- [x] GPT-2 124M weights downloaded into a Volume; tiny fixed prompt set committed.
- [x] One manual paired run executed end-to-end by hand (`sandbox.exec` of a
      bench script at two SHAs). This is the single highest-value item.
- [x] **Noise floor measured**: 0.23% spread best run, ~1–2.4% across runs;
      NOISE_MARGIN_PCT=3.0 in policy.py. Regression = 6–13× noise. Numbers
      in demo/PIN.md.
- [x] Eval suite defined: 2–3 evals in `atlas.yaml` (same bench.py,
      different parameters, e.g. short/long generation).
- [x] Demo regression crafted and confirmed ≥5× noise (see DEMO.md candidates),
      ideally hitting the long eval harder than the short one; the "good
      change" for the passing run confirmed too.
- [x] Full loop timed: sandbox attach → paired run → verdict. Target < 3 min.
- [x] Contracts in ARCHITECTURE.md §4 frozen; example fixture JSONs written
      for: pass, regression, regression+investigation, invalid, near-band flag.
- [x] OpenRouter account + API key (free; stealth `ox-alpha` costs $0 during
      preview); stored as Modal Secret `openrouter-secret`
      (`OPENROUTER_API_KEY`); one test tool-call verified. Confirm the exact
      model ID on openrouter.ai. Keep a paid OpenAI-compatible fallback in
      reserve — ox-alpha has no SLA.
- [x] UI pages sketched — superseded: packet D fully built pre-event
      (`atlas_v1/web/`, respan-style theme, all three routes).
- [x] Investigator system prompt drafted — superseded: packet C fully built
      (`atlas_v1/atlas/investigator/prompts.py`), live-proven on ox-alpha.
- [x] Work packets pasted — executed pre-event by four parallel agents; all
      four packets complete, integrated, and live-proven end to end.
- [ ] Event rules checked: confirm what prep is allowed. If prewriting code is
      allowed, Layer 1 (comparator + fixtures) should exist before doors open.

## 2. Work packets

One owner per packet; one packet = one self-contained brief a coding agent can
execute. No shared files across packets except the frozen fixtures.

### Packet A — Modal runner (the lab)

- **Owns:** `runner.py`, `sandbox.py`, image/Volume setup.
- **Mission:** given `{repo, base_sha, head_sha, atlas.yaml}`, create the
  GPU sandbox, materialize both revisions, run preflight + warmup + paired
  bench blocks (`base→cand→cand→base`, fresh process each), write per-block
  metrics JSON and logs to `runs/<id>/`, emit events, terminate in `finally`.
- **Definition of done:** one function call returns four block-metric files
  and an event stream from a real GPU run on the demo repo.
- **First proof (by 1:45):** two trivial commands run sequentially in one GPU
  sandbox with output captured to the Volume.

### Packet B — Comparator, events, escalation (the referee)

- **Owns:** `comparator.py`, `policy.py`, `events.py`, `report.py`.
- **Mission:** pure functions from block metrics → Verdict object per the
  contract; correctness-first; invalid on malformed/missing data; near-band
  results become flagged items; render the report (JSON for the UI +
  PR-comment Markdown) from a verdict+investigation pair.
- **Definition of done:** all five fixture scenarios produce correct verdicts
  and renderings; zero Modal imports (fully unit-testable locally).
- **First proof (by 1:45):** fixtures → correct pass/regression/invalid.

### Packet C — Investigator (the observer)

- **Owns:** `investigator.py`, `probes.py`, `prompts.py`.
- **Mission:** the Tier-2 agent per ARCHITECTURE.md §1, built on the OpenAI
  Agents SDK (`@function_tool` tools, `max_turns`,
  `output_type=Investigation`). Two jobs: the **run plan** (cheap first call:
  read diff + claims → pick evals + extra metrics, emitted as `plan` events;
  on failure fall back to the full suite) and the **investigation**. The
  agent proposes probes AND their parameters; execution waits on approval
  via a Modal Dict key (instant when `approvals: auto`), with deny/timeout
  returning "not run" to the agent. Ceilings (GPU-seconds ledger, max
  experiments, turn cap) are enforced in the probe callback, not the prompt.
  Probe shapes: confirmation pair; paired profile (torch.profiler, trace to
  Volume); declared override pair. Emits Investigation object incl.
  `fix_context` and unrun proposals.
- **Definition of done:** on the regression fixture, the agent states a
  grounded hypothesis, launches one allowed probe (mocked runner), updates the
  hypothesis from the result, finishes with a diagnosis; hard-stops at budget;
  on model failure the run still completes (Tier 1 rule).
- **First proof (by 1:45):** fixture regression → agent requests an allowed
  probe and stops.

### Packet D — API + UI + demo assets (the face and the story)

- **Owns:** `api/` (FastAPI JSON API on Modal) and `web/` (Next.js App
  Router + shadcn/ui + Tailwind), plus demo assets.
- **Mission:** three routes per ARCHITECTURE.md §6 — repos list, repo detail
  (branch/PR picker + runs table with metric deltas), run detail (verdict
  zone labeled "policy decision", investigation trace with tier-labeled
  spans, report section with highlights and flagged items). Polls the events
  endpoint; replays completed runs beautifully — replay quality > live
  polling. Second half of the afternoon: PR-comment render, architecture
  slide, sped-up video capture, rehearsal props (see DEMO.md).
- **Definition of done:** the full regression fixture feed renders as a
  legible run page with zero explanation needed, reachable by clicking from
  the repos list.
- **First proof (by 1:45):** mocked events feed renders the run page's three
  sections.

## 3. Timeline

| Time | Milestone | Exit condition |
| --- | --- | --- |
| 1:00–1:15 | Freeze: name, contracts, thresholds, owner assignments | Everyone can work without another product discussion |
| 1:15–2:00 | Four thin slices vs. fixtures | All four first-proofs pass |
| 2:00–2:30 | **Checkpoint 1:** A+B integrate | Real GPU run → real verdict, one command |
| 2:30–3:15 | C on real artifacts; D on real feed | Agent investigates a real run; UI shows it |
| 3:15–3:45 | **Checkpoint 2:** full loop | Regression PR → verdict → probe → diagnosis → UI, end to end |
| 3:45–4:15 | Fix loop + passing run | Fix context → agent fix → green re-verify; passing run recorded |
| 4:15–4:30 | Freeze + capture | Hero runs completed and saved; recordings taken |
| 4:30–5:00 | Demo assembly + **two rehearsals** | Under 3:00 twice; tabs/video staged; presenter fixed |

If a checkpoint slips ≥20 minutes, drop one rung on the scope ladder — no
debate, that's what the ladder is for.

## 4. Scope ladder (cut top-down when behind)

Stretch items, built only if ahead of schedule (in order): the **MCP
server** (highest-value stretch: four tools mapping 1:1 to API endpoints
per ARCHITECTURE §7, official MCP Python SDK, ~100 mechanical lines — a
30-minute agent task once the API exists); "Suggest evals" (one Agents SDK
call, `output_type=SuiteDraft`, review-and-commit flow); the "Watch PRs"
polling watcher (Modal scheduled function + GitHub token — otherwise it
ships as a grayed toggle). None are on the critical path.

1. MCP server (already a stretch).
2. Check mode in the demo (keep it in the code — it's mostly the absolute
   branch of policy.py — but demo compare mode only).
3. Live approval flow (fall back to `approvals: auto` everywhere, with the
   proposal cards still rendered in the trace and the toggle shown grayed).
4. Declared-override probe (keep confirmation + profile).
5. Repos + repo-detail pages (fall back to a plain runs list → run detail;
   the run detail page is never cut).
5. Second follow-up probe (keep one agent-chosen probe — never zero).
6. Live-triggered fresh run during demo (fall back to replay only).

**Never cut:** real paired GPU execution; deterministic verdict that survives
agent failure; one agent-chosen probe with visible reasoning; the fix →
green-rerun story; the passing run; the UI trace.

## 5. Risk register (v2-specific)

| Risk | Mitigation |
| --- | --- |
| Agent loop flaky at demo time | Tier 1 completes without it; demo replays a completed run; probe path pre-tested on the exact scenario |
| Modal contention at the venue (every team on sponsor credits) | Hero runs completed and captured by 4:15; video backup; nothing in the 3 minutes depends on live capacity |
| Regression within noise | Tonight's noise-floor measurement; effect ≥5×; confirmation probe in the demo run itself |
| Full run too slow to iterate | nanoGPT chosen for fast loads; small token counts; keep one warm sandbox during development |
| Integration mismatch between four agent-written codebases | Frozen fixtures are the only interface; packets never share files; checkpoints are merge deadlines |
| "You staged your own demo" | Real repo (nanoGPT), regression modeled on a real optimization pattern, passing run alongside, offer variance numbers |
| Demo overruns 3:00 | Two timed rehearsals; DEMO.md script has per-beat timings; cut the live trigger first |
| ox-alpha pulled or rate-limited on event day | Model + base URL are env vars only; swap to the paid fallback in one change; hero runs are pre-recorded anyway |
