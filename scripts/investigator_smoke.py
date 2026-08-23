#!/usr/bin/env python
"""M3 live smoke: run the real investigator against ox-alpha on the PIN.md
regression scenario (mocked probe results, real model, real tool loop).

Usage: .venv/bin/python scripts/investigator_smoke.py [main|budget|bogus|all]

Scenarios:
  main   — full investigation; PASS = valid Investigation, >=1 probe done,
           grounded diagnosis. Prints the Investigation JSON + call latencies.
  budget — max_experiments=0; PASS = agent still concludes, zero probes run.
  bogus  — nonexistent model id; PASS = InvestigatorFailed raised.

The OpenRouter key is loaded from openrouter.env into the process
env only; it is never printed or written anywhere.
"""
import json
import os
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agents import RunHooks

from atlas.contracts.validate import validate
from atlas.investigator import InvestigatorFailed, investigate

RUN = "r_smoke1"

CLAIM = ('Optimize generation: host-side sampling with pinned staging ("~2x '
         'faster generation"). Avoids device RNG divergence across GPU '
         "architectures, removes the sampling kernel launch from the hot "
         "loop, and adds a numerical stability guard. Outputs are bit-identical.")

DIFF = """\
--- a/model.py
+++ b/model.py
@@ -322,8 +322,13 @@ class GPT(nn.Module):
             probs = F.softmax(logits, dim=-1)
-            # sample from the distribution
-            idx_next = torch.multinomial(probs, num_samples=1)
+            # OPT: sample on host via a staging copy. Avoids device RNG
+            # divergence across GPU architectures and removes the sampling
+            # kernel launch from the hot loop; also adds a stability guard.
+            probs_host = probs.detach().to("cpu")
+            if not torch.isfinite(probs_host).all().item():
+                raise RuntimeError("non-finite probabilities in sampling")
+            idx_next = torch.multinomial(probs_host, num_samples=1).to(idx.device)
             idx = torch.cat((idx, idx_next), dim=1)
"""

# Medians measured on A10G 2026-08-22 (demo/PIN.md): regression is LARGER at
# short context (-33.0%) than long (-15.6%) — fixed per-token host cost.
TPS = {"generate_short": {"base": 412.3, "head": 276.2},
       "generate_long": {"base": 389.5, "head": 328.7}}
LAT = {"generate_short": {"base": 311.0, "head": 464.0},
       "generate_long": {"base": 1315.0, "head": 1558.0}}


def load_env():
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "openrouter.env")
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if k.strip().lower() in ("api_key", "openrouter_api_key"):
                    k = "OPENROUTER_API_KEY"
                os.environ.setdefault(k.strip(), v.strip())


def block(label, eval_name, tps, lat_ms, block_i, repeats=3, vram=1912.0, profile=None):
    jit = [0.996, 1.0, 1.004]
    b = {"schema": "1", "status": "completed", "label": label, "block": block_i,
         "eval": eval_name, "params": {"repeats": repeats},
         "samples": {"tokens_per_s": [tps * j for j in jit[:repeats]],
                     "latency_ms_median": [lat_ms * j for j in jit[:repeats]],
                     "latency_ms_p95": [lat_ms * 1.07 * j for j in jit[:repeats]],
                     "peak_vram_mb": [vram + (7 if label == "head" else 0)] * repeats},
         "summary": {"tokens_per_s": tps, "latency_ms_median": lat_ms,
                     "latency_ms_p95": lat_ms * 1.07,
                     "peak_vram_mb": vram + (7 if label == "head" else 0)},
         "output_ids": [[464, 3290, 262, 1110]], "outputs_consistent": True,
         "timing": "cuda_sync_wall",
         "env": {"gpu_name": "NVIDIA A10G", "torch": "2.8.0", "sha": label}}
    if profile:
        b["profile"] = profile
    return b


def _profile(label, tokens):
    """Torch-profiler-style summary. Head: host time dominated by the
    per-token .to("cpu") + .item() sync; GPU forward flat on both sides."""
    fwd = {"aten::mm": 962.4, "aten::_softmax": 171.3, "aten::layer_norm": 88.6}
    if label == "base":
        ops = [{"name": n, "cuda_ms": v, "cpu_ms": round(v * 0.04, 1)} for n, v in fwd.items()]
        ops.append({"name": "aten::multinomial", "cuda_ms": 21.9, "cpu_ms": 4.1,
                    "calls": tokens})
        return {"tokens": tokens, "total_cuda_ms": 1483.0, "total_cpu_ms": 118.0,
                "host_ms_per_token": 0.9, "top_ops": ops}
    per_tok = 13.5  # fixed host cost per generated token
    ops = [{"name": "aten::_local_scalar_dense", "cpu_ms": round(6.1 * tokens, 1),
            "cuda_ms": 1.9, "calls": tokens},
           {"name": "Memcpy DtoH (Device -> Pinned)", "cpu_ms": round(4.6 * tokens, 1),
            "cuda_ms": 6.3, "calls": tokens},
           {"name": "cudaStreamSynchronize", "cpu_ms": round(2.8 * tokens, 1),
            "calls": 2 * tokens}]
    ops += [{"name": n, "cuda_ms": round(v * 1.004, 1), "cpu_ms": round(v * 0.04, 1)}
            for n, v in fwd.items()]
    return {"tokens": tokens, "total_cuda_ms": 1491.0,
            "total_cpu_ms": round(118.0 + per_tok * tokens, 1),
            "host_ms_per_token": round(0.9 + per_tok, 1), "top_ops": ops}


def probe_callback(kind, params):
    ev = params["eval"]
    if kind == "profile_pair":
        t = params.get("tokens", 32)
        # scale medians to the probe's token count region; ratios hold
        return [block("base", ev, TPS[ev]["base"], LAT[ev]["base"], 0, repeats=1,
                      profile=_profile("base", t)),
                block("head", ev, TPS[ev]["head"], LAT[ev]["head"], 1, repeats=1,
                      profile=_profile("head", t))]
    reps = params.get("repeats", 5)
    seq = ["base", "head", "head", "base"] if params.get("order", "abba") == "abba" \
        else ["base", "head"]
    scale = 1.0
    if kind == "override_pair":   # regression ratio persists across batch values
        scale = (params["value"] / 2.0) ** 0.35
    return [block(lbl, ev, TPS[ev][lbl] * scale * (1 + 0.002 * i),
                  LAT[ev][lbl] / scale, i, repeats=reps) for i, lbl in enumerate(seq)]


def build_run(root):
    d = os.path.join(root, RUN)
    os.makedirs(os.path.join(d, "blocks"))
    os.makedirs(os.path.join(d, "logs"))
    spec = {"schema": "1", "run": RUN, "mode": "compare",
            "repo": "rohitsandadi/nanoGPT", "base_sha": "3adf61e154c3",
            "head_sha": "9c2b11d0aa41", "gpu": "A10G", "image": "atlas-torch-2.8.0",
            "selection": "auto", "approvals": "auto", "claim": CLAIM, "diff": DIFF,
            "overrides": ["batch"],
            "evals": [{"name": "generate_short",
                       "cmd": "python /harness/bench.py --eval generate_short --tokens 128 --batch 2 --repeats 5",
                       "checks": {"tokens_per_s": "-10%", "latency_ms_p95": "+15%",
                                  "peak_vram_mb": "+8%"}},
                      {"name": "generate_long",
                       "cmd": "python /harness/bench.py --eval generate_long --tokens 512 --batch 2 --repeats 3",
                       "checks": {"tokens_per_s": "-10%", "latency_ms_p95": "+15%",
                                  "peak_vram_mb": "+8%"}}]}
    checks = []
    for ev in ("generate_short", "generate_long"):
        b, h = TPS[ev]["base"], TPS[ev]["head"]
        checks.append({"metric": "tokens_per_s", "eval": ev, "base": b, "cand": h,
                       "delta_pct": round((h / b - 1) * 100, 2), "threshold": "-10%",
                       "violated": True})
        lb, lh = LAT[ev]["base"] * 1.07, LAT[ev]["head"] * 1.07
        checks.append({"metric": "latency_ms_p95", "eval": ev, "base": round(lb, 1),
                       "cand": round(lh, 1),
                       "delta_pct": round((lh / lb - 1) * 100, 2), "threshold": "+15%",
                       "violated": (lh / lb - 1) * 100 > 15})
    checks.append({"metric": "peak_vram_mb", "eval": "generate_long", "base": 1912.0,
                   "cand": 1919.0, "delta_pct": 0.37, "threshold": "+8%",
                   "violated": False})
    verdict = {"schema": "1", "run": RUN, "verdict": "regression", "checks": checks,
               "correctness": {"result": "match",
                               "per_eval": {"generate_short": "match",
                                            "generate_long": "match"}},
               "claim": {"text": CLAIM, "verified": False}}
    with open(os.path.join(d, "spec.json"), "w") as f:
        json.dump(spec, f, indent=1)
    with open(os.path.join(d, "verdict.json"), "w") as f:
        json.dump(verdict, f, indent=1)
    order = [("base", 0), ("head", 1), ("head", 2), ("base", 3)]
    for ev in ("generate_short", "generate_long"):
        for lbl, i in order:
            with open(os.path.join(d, "blocks", f"b{i}_{lbl}_{ev}.json"), "w") as f:
                json.dump(block(lbl, ev, TPS[ev][lbl], LAT[ev][lbl], i, repeats=3), f)
    with open(os.path.join(d, "logs", "head.stderr"), "w") as f:
        f.write("loading GPT-2 124M from /cache/gpt2_124m.pt\n"
                "generate: 128 tokens, batch 2, seed 1337, top_k 1\n")
    with open(os.path.join(d, "events.jsonl"), "w") as f:
        for ev in ({"kind": "run_created", "detail": {"mode": "compare"}},
                   {"kind": "verdict", "detail": {"verdict": "regression"}}):
            f.write(json.dumps({"t": "2026-08-23T13:00:00Z", "run": RUN,
                                "tier": "system", **ev}) + "\n")
    return spec, verdict


class Latency(RunHooks):
    def __init__(self):
        self.calls: list[float] = []
        self._t0 = 0.0

    async def on_llm_start(self, *a, **k):
        self._t0 = time.monotonic()

    async def on_llm_end(self, *a, **k):
        self.calls.append(time.monotonic() - self._t0)


def scenario_main() -> bool:
    with tempfile.TemporaryDirectory() as root:
        spec, verdict = build_run(root)
        hooks = Latency()
        t0 = time.monotonic()
        inv = investigate(RUN, root, spec, verdict, probe_callback,
                          approval_lookup=lambda key: "approved", hooks=hooks)
        wall = time.monotonic() - t0
        validate(inv, "investigation")
        print(json.dumps(inv, indent=1))
        print(f"\nwall {wall:.0f}s over {len(hooks.calls)} model calls: "
              + ", ".join(f"{c:.1f}s" for c in hooks.calls))
        with open(os.path.join(root, RUN, "events.jsonl")) as f:
            agent_events = [l.strip() for l in f if '"tier": "agent"' in l]
        print(f"agent events ({len(agent_events)}):")
        for l in agent_events:
            print(" ", l[:200])
        done = [p for p in inv["proposals"] if p["status"] == "done"]
        ok = (inv["status"] in ("completed", "inconclusive") and done
              and all(o["refs"] for o in inv["observations"])
              and inv.get("diagnosis", {}).get("text"))
        print(f"\nprobes run: {[(p['kind'], p['params']) for p in done]}")
        print("MAIN:", "PASS" if ok else "FAIL")
        return bool(ok)


def scenario_budget() -> bool:
    with tempfile.TemporaryDirectory() as root:
        spec, verdict = build_run(root)

        def no_probe(kind, params):
            raise AssertionError("probe_callback must not run with max_experiments=0")
        inv = investigate(RUN, root, spec, verdict, no_probe,
                          approval_lookup=lambda key: "approved", max_experiments=0)
        validate(inv, "investigation")
        ok = not [p for p in inv["proposals"] if p["status"] == "done"]
        print(f"status={inv['status']} proposals={inv['proposals']} "
              f"confidence={inv.get('diagnosis', {}).get('confidence')}")
        print("BUDGET:", "PASS (hard-stop held, agent still concluded)" if ok else "FAIL")
        return ok


def scenario_bogus() -> bool:
    with tempfile.TemporaryDirectory() as root:
        spec, verdict = build_run(root)
        os.environ["ATLAS_MODEL"] = "stealth/does-not-exist"
        try:
            investigate(RUN, root, spec, verdict, probe_callback,
                        approval_lookup=lambda key: "approved", max_turns=2)
        except InvestigatorFailed as e:
            print(f"BOGUS: PASS (InvestigatorFailed: {str(e)[:140]})")
            return True
        finally:
            del os.environ["ATLAS_MODEL"]
        print("BOGUS: FAIL (no InvestigatorFailed raised)")
        return False


if __name__ == "__main__":
    load_env()
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    results = {}
    if which in ("main", "all"):
        results["main"] = scenario_main()
    if which in ("budget", "all"):
        results["budget"] = scenario_budget()
    if which in ("bogus", "all"):
        results["bogus"] = scenario_bogus()
    print("\n== " + "  ".join(f"{k}:{'PASS' if v else 'FAIL'}" for k, v in results.items()))
    sys.exit(0 if all(results.values()) else 1)
