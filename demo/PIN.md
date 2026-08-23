# Demo pins and claims

- Upstream: karpathy/nanoGPT @ `3adf61e154c3fe3fca428ad6bc3818b27a3b8291`
- Fork: https://github.com/rohitsandadi/nanoGPT (branches to create in Phase 4:
  `atlas-base` = pin + bench.py + atlas.yaml; `opt-sampling` = + regression.patch;
  `fix-sampling` = revert; `opt-allocation` = + passing.patch)

## Regression PR (the false claim)

Patch: `patches/regression.patch` — moves per-token sampling to host with a
"stability guard" (`.to("cpu")` + `isfinite().all().item()` per token =
transfer + sync every token). Outputs identical (greedy top_k=1).

PR body claim (paste verbatim):
> Optimize generation: host-side sampling with pinned staging ("~2x faster
> generation"). Avoids device RNG divergence across GPU architectures,
> removes the sampling kernel launch from the hot loop, and adds a numerical
> stability guard. Outputs are bit-identical.

Measured (A10G, 2026-08-22): tokens/s regression **larger on generate_short
(-33.0%) than generate_long (-15.6%)** — the host cost is fixed per token,
so it dominates when per-token compute is small (no KV cache: long contexts
make forwards expensive). VRAM flat; outputs match. Profile probe should
show GPU forward flat, host time up. The diagnosis story: "constant
per-token overhead, worse at short context -> host-side stall in the
sampling path, not scaling compute."

## Passing PR (the true claim)

Patch: `patches/passing.patch` — `@torch.no_grad()` -> `@torch.inference_mode()`
on generate(). Claim: "minor speedup from inference-mode tensors; outputs
identical." Expected: small tokens/s gain or flat; PASS.

## Measured numbers (A10G, 2026-08-22)

- noise floor: 0.23% spread (best run); ~1-2.4% across runs -> margin 3%
- regression effect: short **-33.0%**, long **-15.6%** (6-13x noise) ✅
- passing effect: **+3.47%** tokens/s, outputs match -> PASS ✅
- full paired run wall time: ~60s short, ~90s long; sandbox up in ~1s
- delta in noise mode: +0.10%; outputs exact-match in every run
