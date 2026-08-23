# Atlas Demo (v2)

Format: 3 minutes demo + 2 minutes Q&A, judged fast and at a high level.
Structure follows: problem → solution → architecture → walkthrough → close.
Pre-recorded and sped-up segments are explicitly fine and are the spine;
anything live is bonus.

## 1. Demo repo: nanoGPT

Why: real, tiny, pure PyTorch, universally recognized by this judging pool,
model loads in seconds (GPT-2 124M), benchmark is self-evident (tokens/sec),
and plausible "agent optimization" PRs are easy to craft against `generate()`.

### Benchmark scenario (`bench.py` + `atlas.yaml` on a fork)

- Load GPT-2 124M from the Volume cache; fixed prompts; fixed seed.
- Generate N tokens (N sized tonight so a paired run stays under ~3 min).
- Emit: tokens/sec, per-token p95 latency, peak allocated/reserved VRAM,
  and the generated token IDs (correctness = exact match under fixed seed).

### The regression PR (the false claim) — candidates, pick tonight

The PR is framed as agent-authored, with a PR body claiming a speedup.
Requirements: plausible-looking, outputs identical, effect ≥5× noise floor,
localizes cleanly under the profile probe. Candidates in order of preference:

1. **Per-token host sync**: an "optimization" to the sampling path that
   introduces a `.item()` / `.cpu()` per generated token (e.g., "early-exit
   check" or "numerical-stability guard"). Classic real-world bug; profile
   shows GPU idle gaps and time moving to host; outputs unchanged.
2. **Redundant tensor materialization**: "memory-layout optimization" adding
   `.contiguous()` / dtype round-trips in the hot loop.
3. **Broken caching claim**: a change that claims to cache computation but
   recomputes — honest inspiration: real KV-cache PRs.

Also prepare **the passing PR**: a genuinely good small change (e.g., moving a
constant tensor allocation out of the loop) so the gate visibly verifies a
true claim. One extra run, kills the "it only says no" and "you caught your
own plant" objections.

### The fix loop

The `fix_context` JSON is handed to a coding agent (Claude Code/Codex) with
the success condition. It reverts/repairs the hot path; re-verify runs; green.
Captured as a sped-up recording before 4:15 — never live.

## 2. Assets to have staged by 4:30

1. UI tab: repos page → nanoGPT repo → runs (hero regression run, passing
   run, one flagged near-band example).
2. UI tab: hero run page, replaying the completed investigation + report.
3. Rendered PR comment (the static door) — one image or tab.
4. One architecture slide (the three tiers + Modal boxes).
5. Sped-up fix-loop video (~20s).
6. Full-demo screen recording as total-failure backup.
7. Timer on the phone. Presenter decided. Two rehearsals done.

## 3. The script (3:00)

**0:00–0:25 — Problem.** [PR on screen]
> "Coding agents write performance-critical inference code now, and they're
> confident: this PR says *2x faster generation*. Tests pass — tests check
> logic, not hardware. Reviewers can't measure it. Claims like this merge on
> vibes every day."

**0:25–0:40 — Solution.**
> "Atlas is verification for agent-written inference code. Before a
> claim is believed, it runs as a controlled experiment on a real GPU.
> Agents write the code; hardware gives the verdict."

**0:40–1:05 — Architecture.** [one slide: the lifecycle line, six verbs —
Submit → Plan → Measure → Verdict → Investigate → Verify — with one clause
under each; not a box diagram]
> "Six steps. Submit a change; the agent reads its claims and plans which
> evals to run; both versions measure paired on the same Modal GPU — pinned
> image, immutable SHAs, no dirty state; a deterministic policy issues the
> verdict — the agent can't grade its own work; on a regression the agent
> proposes follow-up experiments; and the fix gets verified the same way."

**1:05–2:20 — Walkthrough.** [UI, hero run replay]
> "The repo declares its evals once — like a test suite, but for behavior on
> hardware. Here's that PR: Atlas read the claim, planned the run — it chose
> the generation evals and turned on per-token latency, its reasoning is
> right here in the trace. Verdict, from policy, not from a model: REGRESSION — the
> claimed 2x speedup is actually 22% *slower*, outputs identical, so ordinary
> tests would never catch it. Now the part a human would normally spend an
> afternoon on: the investigator saw the slowdown, asked whether it's GPU
> compute or host-side, and **proposed** a paired profile — its parameters,
> its reasoning, its GPU cost, right here as a card. You approve it (or set
> auto-approve and let it run); nothing burns GPU time without a yes.
> Result: GPU forward time flat,
> per-token host stalls growing. Diagnosis, with evidence attached: a sync
> added in the generate loop." [switch: fix video, sped up] "That evidence
> bundle goes straight to the coding agent — and the PR comment can ping a
> review bot like @greptileai with it too. The agent fixes, Atlas re-verifies:
> green, claim now true." [flash run list] "And here's a good PR it verified
> and passed — the gate says yes when the claim is real."

**2:20–2:45 — Close.**
> "Any repo with a benchmark command gets this — the same contract as adding
> tests. Built entirely on Modal: the sandbox, the evidence store, the agent,
> this UI. As agents write more of the code, verification is the layer that
> lets you trust it. Agents write; hardware decides."

**2:45–3:00 — buffer.** It will be needed.

## 4. Q&A — the four answers to know cold

- **"Why can't I just ask Claude Code to benchmark it?"**
  "It wrote the change — self-grading isn't verification. And it doesn't have
  two runs on the same physical GPU under a controlled protocol. We measured
  our noise floor at ±X%; an agent timing things ad hoc across machines can't
  distinguish that from a real regression. Independence plus the lab is the
  product."
- **"Does this actually save time?"**
  "It replaces manual benchmarking — an afternoon per change — or, more
  honestly, replaces not checking at all. The investigator does the log
  reading and follow-up experiments a human would do; the human only gets the
  calls that genuinely need judgment."
- **"How do I know that's not noise?"**
  "Same physical GPU, interleaved order, repeats. Noise floor ±X%, effect Y×
  that, and the investigator's confirmation reproduced it. The numbers are in
  the evidence links."
- **"Why Modal?"**
  "On-demand identical-device paired GPU runs, sandbox isolation from the
  code under test, and the whole product — controller, storage, agent, UI —
  runs on it. Without Modal we'd own a GPU fleet."

If asked about prior art (CodSpeed, benchmark actions): "They compare numbers
in CI. We run the experiment on real paired GPUs and the investigation that
explains it — and the output is machine-readable so the authoring agent can
fix and re-verify without a human." One breath, don't elaborate unless pushed.

## 5. Judging map

| Criterion | Where it's shown |
| --- | --- |
| Technical difficulty (30%) | Paired same-GPU protocol + live sandbox lifecycle in the trace + agent tool loop — all visible in the UI, named once on the architecture slide |
| Execution (25%) | Replayed real runs, polished single-page UI, green rerun, nothing waits on live infra |
| Creativity (20%) | The visible moment: agent observes → chooses experiment → new evidence. Say "its choice, its stated reason" out loud |
| Impact (15%) | The agent-era claim + "same contract as adding tests" honesty |
| Presentation (10%) | The script above, rehearsed twice, under 3:00 |
