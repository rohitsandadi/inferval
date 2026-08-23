# Atlas Code References (v2)

Proven code to build from, organized by module. Rule: adapt tested logic
instead of inventing it — especially the Modal parts. Read only the section
for the module you're working on. `../old/REFERENCES.md` has the full v1
link index (Modal docs deep links, GitHub security, prior art); this file is
the curated build-day set.

## M1 Runner + M5 Controller (Modal execution) — Person A

Working code to copy patterns from:

- [modal-examples/13_sandboxes/safe_code_execution.py](https://github.com/modal-labs/modal-examples/blob/main/13_sandboxes/safe_code_execution.py)
  — sandbox create/exec/terminate lifecycle done right. The base pattern for
  `sandbox_mgr.py`.
- [modal-examples/13_sandboxes/sandbox_agent.py](https://github.com/modal-labs/modal-examples/blob/main/13_sandboxes/sandbox_agent.py)
  — an agent driving a sandbox ([doc version](https://modal.com/docs/examples/sandbox_agent)).
  Shows exec streaming and file handling from outside the sandbox.
- [modal-labs/stopwatch `benchmark.py`](https://github.com/modal-labs/stopwatch/blob/main/src/stopwatch/benchmark.py)
  and [`resources.py`](https://github.com/modal-labs/stopwatch/blob/main/src/stopwatch/resources.py)
  — Modal's own inference benchmarking: measurement lifecycle, structured
  results, centralized app/volume/image definitions. Closest thing to Atlas's
  runner that already exists; steal its structure.
- [CI on Modal example](https://modal.com/docs/examples/ci-on-modal) —
  remote execution triggered from a repo, image caching.
- [Torch profiling example](https://modal.com/docs/examples/torch_profiling)
  — the profile probe: bounded torch.profiler capture, trace to Volume.
- Modal docs (deep links in `../old/REFERENCES.md`): Sandboxes, sandbox
  exec/spawn, readiness probes, GPU config, GPU health, sandbox networking,
  Volumes, named images, `Function.spawn` + FunctionCall logs, timeouts.

## M2 Referee (comparison + policy) — Person B

- [NVIDIA CCCL `compare_git_refs.sh`](https://github.com/NVIDIA/cccl/blob/main/ci/bench/compare_git_refs.sh)
  and [`compare_paths.sh`](https://github.com/NVIDIA/cccl/blob/main/ci/bench/compare_paths.sh)
  — a real project comparing two git refs' benchmarks: worktree layout,
  artifact naming, report lifecycle.
- [github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark)
  — threshold/alert logic and result JSON shape from the most-used OSS
  benchmark gate. Also the commodity baseline we must beat, so know it.
- [Bencher run model](https://bencher.dev/docs/explanation/bencher-run/) —
  branch/testbed identity and threshold semantics, good sanity check for
  `policy.py`.
- [Inference-Autopsy regression workflow](https://github.com/kaseyho/Inference-Autopsy/blob/main/.github/workflows/inference-regression.yml)
  — the run → always-report → always-upload → exit-last ordering our
  controller copies (evidence survives a failing verdict).

## M3 Investigator (OpenAI Agents SDK) — Person C

- [OpenAI Agents SDK docs](https://openai.github.io/openai-agents-python/) —
  the harness: [Agents](https://openai.github.io/openai-agents-python/agents/)
  (instructions, `output_type` structured output),
  [Tools](https://openai.github.io/openai-agents-python/tools/)
  (`@function_tool` on plain Python functions),
  [Running agents](https://openai.github.io/openai-agents-python/running_agents/)
  (`Runner.run`, `max_turns`, `MaxTurnsExceeded`).
- [modal-labs/openai-agents-python-example](https://github.com/modal-labs/openai-agents-python-example)
  — the Agents SDK + Modal Sandboxes together, from Modal themselves. The
  closest existing code to our investigator setup.
- [openai-cookbook: How_to_call_functions_with_chat_models.ipynb](https://github.com/openai/openai-cookbook/blob/main/examples/How_to_call_functions_with_chat_models.ipynb)
  — the raw tool loop, kept as the fallback if the SDK misbehaves.
- Considered and not chosen: [pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
  (Mario Zechner's minimal coding-agent harness) — excellent, but TypeScript
  and shaped as a terminal coding agent (read/write/edit/bash); wrong fit for
  an embedded Python investigator. Viable alternative on the *fix-loop* side,
  interchangeable with Codex CLI there.
- GPU-seconds ledger, context building, and probe validation are
  Atlas-specific — spec is ARCHITECTURE.md §1 Tier 2.

## M4 API + UI — Person D

- [langfuse/langfuse](https://github.com/langfuse/langfuse) — open source,
  built on Next.js + shadcn/ui + Tailwind (our exact stack). Direct reference
  for the trace view (spans tree, timings, metadata panel) and general layout.
- [shadcn/ui](https://ui.shadcn.com) — table, badge, card, tabs components;
  use defaults, don't theme on day one.
- Datadog Bits / Gemini Cloud Assist investigation UIs (links in
  `../old/REFERENCES.md`) — the observations + hypotheses + evidence-links
  display pattern for the report section.
- Modal [`@modal.asgi_app()` docs](https://modal.com/docs/guide/webhooks) —
  serving FastAPI from the same Modal app.

## Demo repo — Person D + A

- [karpathy/nanoGPT](https://github.com/karpathy/nanoGPT) — the fork target.
  [`bench.py`](https://github.com/karpathy/nanoGPT/blob/master/bench.py)
  (timing discipline, dtype/compile knobs) + `sample.py` (generation path)
  are the starting points for our `bench.py`; `model.py:generate` is where
  the regression PR lands.
- DEMO.md §1 has the regression candidates and requirements.

## Positioning / market (for the pitch, not the build)

Wafer, Salus, Arga, Lemma, Braintrust framings and the YC 2026 RFS — links
and quotes are in README.md §Why-now. No need to re-research.
