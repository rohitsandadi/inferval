# Atlas

**Evals and verification for agent-written inference code.**

Working name: *Atlas*. Alternatives if the team prefers: *Verdict*, or keeping
*GPUGate* from v1. Decide in the first 15 minutes and never revisit.

Status: canonical v2 proposal — supersedes everything in `old/`.
Repo for the demo: **nanoGPT**. Build constraint: four people, all code written by
coding agents, code freeze at 4:30 PM.

---

## Positioning

This section is the most important one in the folder. It's written to match how
the current wave of funded companies in this exact space describe themselves,
because that phrasing is what the judges already have a mental slot for.

### The one-liner (YC directory style)

> **Atlas — evals and verification for agent-written inference code.**

Why this phrasing: it follows the two-noun-category + wedge convention used by
the companies judges know:

| Company | Their framing | The convention |
| --- | --- | --- |
| Braintrust | "Eval and observability platform for AI products" | two-noun category + audience |
| Salus (YC W26) | "Validates agent actions before execution" | mechanism as category |
| Greptile | "AI code review with full context of your codebase" | category + differentiator |
| Wafer (YC) | "AI that makes AI fast" | compressed aspiration |
| Lemma | "Catches silent failures observability tools miss" | the gap as the pitch |

Ours borrows Braintrust's category shape ("verification and observability")
and Salus's wedge (agent output is the thing being checked). "Inference code"
is the vertical claim — it says GPU/hardware without saying either word.

### The hero line (landing page / opening slide)

> **Agents write the code. Hardware gives the verdict.**

Sub-head:

> Atlas runs every performance claim as a controlled experiment on real
> GPUs — base vs. candidate, paired on identical hardware — and returns a
> deterministic verdict, an agent-run investigation, and evidence your coding
> agent can act on.

### The narrative arc (30-second version, in the style that works online)

The funded-company pitch in this space always has three beats — the shift, the
gap, the product. Ours:

1. **The shift.** Coding agents now write performance-critical inference code.
   They open PRs that say "~2x faster." (Wafer built a company on agents
   writing exactly this code.)
2. **The gap.** Nobody measures those claims. Tests check logic, not behavior
   on hardware. Reviewers guess. The claims merge on vibes.
3. **The product.** Atlas is the gate: before a claim is believed, it runs
   as a real experiment on a real GPU. Regressions come back with a traced
   cause. Verified changes come back with a receipt.

### How it works (three steps, landing-page convention)

1. **Declare your evals** — a suite of scenarios and checks in `atlas.yaml`,
   the way pytest made tests a first-class repo artifact. Run them on a
   commit like tests, or paired base-vs-candidate on a PR.
2. **A change lands** (from a human or an agent). Atlas reads the diff and
   its claims and plans the run: which evals matter, what to measure beyond
   the always-on basics. Then it executes them on a Modal GPU sandbox —
   same image, weights, inputs, seeds, warmup, and measurement protocol on
   both sides.
3. **Get the verdicts.** Deterministic pass/regression per check. On a
   regression, the investigator runs follow-up experiments, localizes the
   cause, and emits machine-readable evidence — your coding agent consumes
   it, fixes, and re-verifies automatically.

## Why this isn't a wrapper on Claude Code / Codex

The question every judge asks, answered structurally:

- **The agent under review can't verify itself.** Self-grading isn't
  verification. Independence is the product.
- **The mechanism is a lab, not a prompt.** Same physical GPU for both
  revisions, interleaved run order, warmup, synchronized timing, repeated
  samples, retained evidence. An agent with a terminal produces an opinion;
  this produces a reproducible experiment.
- **The verdict is not an LLM output.** Deterministic policy decides
  pass/regression. The agent investigates; it cannot grade.

## Why now (receipts, for the pitch and Q&A)

- Code verification is the biggest 2026 dev-tools funding theme (Qodo, Code
  Metal, Momentic; Braintrust at $800M valuation; Cisco acquiring Galileo).
- 41.5% of YC W26 is agent infrastructure; the recurring bet is "agents
  produce work at volume → someone must check it" (Salus, Arga, Lemma).
- Wafer proves agents write GPU performance code — and every agent-written
  optimization is an unverified claim until it runs on hardware.
- YC's 2026 RFS names "unstable GPU infrastructure and poorly tooled" AI
  development as an open problem.

## Hackathon scope in one paragraph

One vertical slice, fully real: nanoGPT with a declared benchmark; an
agent-authored "optimization" PR whose claim is false; a paired experiment on
one Modal GPU sandbox; a deterministic REGRESSION verdict; the investigator
choosing and running one follow-up probe that localizes the cause; evidence
handed to a coding agent; the fix re-verified green. One web UI shows all of
it live. A passing run sits alongside so the gate demonstrably says yes as
well as no. Everything else — GitHub App, MCP surface, multiple repos,
arbitrary setup — is a static artifact, a one-sentence mention, or absent.

## Files

1. [`PRD.md`](PRD.md) — the one-page map; start here.
2. `README.md` — this file: positioning and product.
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) — decision tiers, contracts,
   investigator, Modal mapping, UI spec.
4. [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — modules, tech choices,
   interfaces, inline reviews.
5. [`BUILD_PLAN.md`](BUILD_PLAN.md) — pre-event checklist, work packets,
   timeline, scope ladder, risks.
6. [`DEMO.md`](DEMO.md) — nanoGPT demo design, 3-minute script, Q&A answers.
7. [`REFERENCES.md`](REFERENCES.md) — proven code to build from, per module.

`old/` holds the v1 (GPUGate) docs. The architecture there is largely still
valid and `old/REFERENCES.md` remains the link index for Modal/Greptile/prior
art; v2 changes the framing, the agent's role, the entry surfaces, the demo
repo, and the scope discipline.
