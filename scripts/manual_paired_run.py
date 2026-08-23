"""Phase-1 step 4: the hand-driven paired run. This is tonight's money shot;
M1's paired_runner productizes exactly this known-good invocation.

Runs base and head sequentially in ONE GPU sandbox, interleaved b-h-h-b,
fresh process per block, and prints noise/delta analysis.

Usage (from atlas_v1/):
  # noise floor (same code both sides):
  .venv/bin/python scripts/manual_paired_run.py --mode noise

  # regression candidate:
  .venv/bin/python scripts/manual_paired_run.py --patch regression.patch

  # passing candidate:
  .venv/bin/python scripts/manual_paired_run.py --patch passing.patch

  # add --eval generate_long --tokens 512 for the long eval
"""
import argparse
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import modal
from atlas.runner.images import NANOGPT_SHA, NANOGPT_URL, harness_image
from atlas.runner.volumes import cache_volume, runs_volume

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sh(sb, cmd: str, check: bool = True) -> str:
    p = sb.exec("bash", "-c", cmd)
    out = p.stdout.read()
    err = p.stderr.read()
    p.wait()
    if check and p.returncode != 0:
        raise RuntimeError(f"cmd failed ({p.returncode}): {cmd}\n{out}\n{err}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="patch", choices=["noise", "patch"])
    ap.add_argument("--patch", default=None, help="file in demo/patches/")
    ap.add_argument("--eval", dest="eval_name", default="generate_short")
    ap.add_argument("--tokens", type=int, default=128)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--gpu", default="A10G")
    ap.add_argument("--profile", action="store_true")
    args = ap.parse_args()

    run_id = f"manual_{int(time.time())}"
    app = modal.App.lookup("atlas-manual", create_if_missing=True)
    print(f"[{run_id}] creating {args.gpu} sandbox ...")
    t0 = time.time()
    sb = modal.Sandbox.create(
        app=app,
        image=harness_image(ROOT),
        gpu=args.gpu,
        volumes={"/cache": cache_volume(), "/runs": runs_volume()},
        timeout=1800,
    )
    try:
        print(f"  sandbox up in {time.time()-t0:.1f}s; gpu check:")
        print("  " + sh(sb, "nvidia-smi --query-gpu=name --format=csv,noheader").strip())

        clone = (f"git clone -q {NANOGPT_URL} {{d}} && cd {{d}} && "
                 f"git checkout -q {NANOGPT_SHA}")
        sh(sb, clone.format(d="/work/base"))
        sh(sb, clone.format(d="/work/head"))
        if args.mode == "patch":
            if not args.patch:
                raise SystemExit("--patch required in patch mode")
            sh(sb, f"cd /work/head && git apply /harness/patches/{args.patch}")
            print(f"  applied {args.patch} to head")
        else:
            print("  noise mode: head == base")

        sh(sb, f"mkdir -p /runs/{run_id}")
        order = ["base", "head", "head", "base"]
        results = []
        for i, label in enumerate(order):
            out = f"/runs/{run_id}/b{i}_{label}.json"
            prof = " --profile" if (args.profile and i in (0, 1)) else ""
            t = time.time()
            sh(sb, f"python /harness/bench.py --src /work/{label} "
                   f"--label {label} --block {i} --eval {args.eval_name} "
                   f"--tokens {args.tokens} --batch {args.batch} "
                   f"--repeats {args.repeats} "
                   f"--weights /cache/gpt2_124m.pt "
                   f"--prompts /harness/prompts.json --out {out}{prof}")
            r = json.loads(sh(sb, f"cat {out}"))
            results.append(r)
            s = r.get("summary", {})
            print(f"  block {i} {label}: {s.get('tokens_per_s', 0):8.1f} tok/s  "
                  f"{s.get('latency_ms_median', 0):8.1f} ms  "
                  f"vram {s.get('peak_vram_mb', 0):7.1f} MB  "
                  f"({time.time()-t:.1f}s)")

        # analysis
        base = [r for r in results if r["label"] == "base"]
        head = [r for r in results if r["label"] == "head"]
        b_tps = [r["summary"]["tokens_per_s"] for r in base]
        h_tps = [r["summary"]["tokens_per_s"] for r in head]
        spread = lambda xs: (max(xs) - min(xs)) / statistics.median(xs) * 100
        delta = (statistics.median(h_tps) / statistics.median(b_tps) - 1) * 100
        match = all(r.get("output_ids") == results[0].get("output_ids")
                    for r in results)
        print("\n===== analysis =====")
        print(f"  base tokens/s : {b_tps}  (spread {spread(b_tps):.2f}%)")
        print(f"  head tokens/s : {h_tps}  (spread {spread(h_tps):.2f}%)")
        print(f"  head vs base  : {delta:+.2f}% tokens/s")
        print(f"  outputs match : {match}")
        print(f"  evidence      : volume atlas-runs /{run_id}/")
        if args.mode == "noise":
            print(f"  NOISE FLOOR ~= max spread = "
                  f"{max(spread(b_tps), spread(h_tps)):.2f}% -> set thresholds >= 5x this")
    finally:
        sb.terminate()
        print("sandbox terminated")


if __name__ == "__main__":
    main()
