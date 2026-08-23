"""Live M6 check: GPU telemetry + warm-pool park/reuse on one real A10G.

Same manual-sandbox pattern as scripts/manual_paired_run.py (app
"atlas-manual" — NOT the deployed production app). Sequence:

  1. create one A10G sandbox, clone the pinned nanoGPT into /work/<run1>/base
  2. run ONE bench block (generate_short, repeats 2) via the REAL
     paired_runner.run_blocks path with telemetry on; print the parsed
     telemetry summary and verify the JSON landed next to the block file
  3. park the sandbox in the atlas-sandboxes Dict (60s deadline), look it
     up with controller.reuse_candidate, poll it, and reuse it for a second
     single block under a NEW run id (fresh clone dir)
  4. terminate + mark "terminated" in the Dict

Total GPU time well under 5 minutes.

Usage (from atlas_v1/): .venv/bin/python scripts/telemetry_check.py
"""
import datetime
import json
import os
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# controller-side persistence lands locally; the sandbox still writes /runs
RUNS_LOCAL = tempfile.mkdtemp(prefix="atlas_telcheck_")
os.environ["ATLAS_RUNS_ROOT"] = RUNS_LOCAL

import modal
from atlas.contracts.names import DICT_SANDBOXES, WEIGHTS_PATH
from atlas.controller import controller
from atlas.runner import artifacts, paired_runner, revisions
from atlas.runner.images import NANOGPT_SHA, NANOGPT_URL, harness_image
from atlas.runner.sandbox_mgr import sh
from atlas.runner.volumes import cache_volume, runs_volume

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL = {"name": "generate_short",
        "cmd": "python /harness/bench.py --tokens 128 --batch 2 --repeats 2"}


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec="seconds")


def one_block(sb, run_id: str) -> bool:
    """Clone fresh (/work/<run_id>/base), run one telemetry-on bench block,
    print the parsed telemetry summary. Returns telemetry-file-exists."""
    revisions.materialize(sb, NANOGPT_URL, NANOGPT_SHA, f"/work/{run_id}/base")
    spec = {"run": run_id, "mode": "check", "repo": NANOGPT_URL, "gpu": "A10G"}
    t0 = time.time()
    b = paired_runner.run_blocks(sb, spec, EVAL)[0]
    s = b.get("summary", {})
    print(f"  block b0_base: status={b['status']} "
          f"tokens/s={s.get('tokens_per_s', 0):.1f} "
          f"vram={s.get('peak_vram_mb', 0):.1f}MB ({time.time()-t0:.1f}s)")
    blk = artifacts.block_path(run_id, "blocks", 0, "base", "generate_short")
    tel = artifacts.telemetry_path(run_id, "blocks", 0, "base",
                                   "generate_short")
    print(f"  block json landed: {os.path.isfile(blk)} ({blk})")
    print(f"  telemetry landed : {os.path.isfile(tel)} ({tel})")
    if os.path.isfile(tel):
        with open(tel) as f:
            t = json.load(f)
        u = t["util_gpu"]
        print(f"  telemetry summary: samples={len(u)} "
              f"interval_s={t['interval_s']} "
              f"util min/mean/max={min(u)}/{statistics.mean(u):.1f}/{max(u)} "
              f"mem_mb max={max(t['mem_mb'])} "
              f"power_w max={max(t['power_w']):.1f}")
    return os.path.isfile(tel)


def main():
    app = modal.App.lookup("atlas-manual", create_if_missing=True)
    pool = modal.Dict.from_name(DICT_SANDBOXES, create_if_missing=True)
    run1 = f"telcheck_{int(time.time())}"
    print(f"[{run1}] creating A10G sandbox (app atlas-manual) ...")
    t0 = time.time()
    sb = modal.Sandbox.create(
        app=app, image=harness_image(ROOT), gpu="A10G",
        volumes={"/cache": cache_volume(), "/runs": runs_volume()},
        timeout=1800)
    sid = sb.object_id
    try:
        print(f"  sandbox {sid} up in {time.time()-t0:.1f}s")
        rc, _, _ = sh(sb, f"test -f {WEIGHTS_PATH}", check=False)
        if rc != 0:
            raise SystemExit(f"weights missing at {WEIGHTS_PATH}; "
                             "run scripts/download_weights.py first")

        print("--- run 1: telemetry on a fresh sandbox ---")
        ok1 = one_block(sb, run1)

        print("--- park (60s deadline) + lookup + reuse ---")
        pool[sid] = {"repo": NANOGPT_URL, "gpu": "A10G", "state": "cooldown",
                     "deadline": int(time.time()) + 60,
                     "attached": {"run": run1}, "created_at": now_iso()}
        print(f"  parked {sid} in Dict {DICT_SANDBOXES}")

        entries = {k: v for k, v in pool.items()}
        cand = controller.reuse_candidate(entries, NANOGPT_URL, "A10G",
                                          time.time())
        print(f"  reuse_candidate -> {cand}")
        assert cand == sid, f"expected {sid}, got {cand}"
        sb2 = modal.Sandbox.from_id(cand)
        alive = sb2.poll() is None
        print(f"  poll alive -> {alive}")
        assert alive, "parked sandbox is dead"
        e = dict(pool.get(cand) or {})
        run2 = run1 + "_reuse"
        e.update({"state": "running", "deadline": None,
                  "attached": {"run": run2}})
        pool[cand] = e

        print("--- run 2: telemetry on the REUSED sandbox, fresh clone ---")
        ok2 = one_block(sb2, run2)

        print(f"\ntelemetry files present: run1={ok1} run2={ok2}")
        print(f"local evidence root: {RUNS_LOCAL}")
        if not (ok1 and ok2):
            raise SystemExit("telemetry file missing on a run")
    finally:
        sb.terminate()
        try:
            e = dict(pool.get(sid) or {})
            e["state"] = "terminated"
            pool[sid] = e
            print(f"terminated {sid} and marked in {DICT_SANDBOXES}")
        except Exception as exc:
            print(f"terminated {sid}; Dict mark failed: {exc}")


if __name__ == "__main__":
    main()
