"""Submit the demo regression run through the deployed controller.

Usage (from atlas_v1/, after `modal deploy atlas/controller/app.py`):
  .venv/bin/python scripts/submit_demo_run.py           # spawn, print ids
  .venv/bin/python scripts/submit_demo_run.py --wait    # block, print report
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import modal
import yaml

from atlas.contracts.names import APP_NAME, CONTROLLER_FUNCTION
from atlas.runner.images import NANOGPT_SHA, NANOGPT_URL

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_spec(eval_names, patch, claim, run_id=None, approvals=None):
    with open(f"{ROOT}/demo/atlas.yaml") as f:
        y = yaml.safe_load(f)
    evals = []
    for n in eval_names:
        e = y["evals"][n]
        ev = {"name": n, "cmd": e["cmd"], "checks": e.get("checks", {})}
        if "absolute" in e:
            ev["absolute"] = e["absolute"]
        evals.append(ev)
    spec = {"schema": "1", "run": run_id or f"demo_{int(time.time())}",
            "mode": "compare", "repo": NANOGPT_URL,
            "base_sha": NANOGPT_SHA, "head_sha": NANOGPT_SHA,
            "gpu": y["gpu"], "image": y["image"], "evals": evals,
            "selection": "all",
            "approvals": approvals or y.get("approvals", "manual"),
            "overrides": y.get("overrides", [])}  # probe whitelist
    if patch:
        spec["patch"] = patch
        with open(f"{ROOT}/demo/patches/{patch}") as f:
            spec["diff"] = f.read()  # what the planner/investigator read
    if claim:
        spec["claim"] = claim
    return spec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evals", default="generate_short")
    ap.add_argument("--patch", default="regression.patch",
                    help="file in demo/patches/, or '' for none")
    ap.add_argument("--claim", default="removes the sampling kernel launch "
                    "from the hot loop (faster generation)")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--approvals", default=None, choices=["auto", "manual"])
    ap.add_argument("--wait", action="store_true")
    args = ap.parse_args()

    spec = build_spec(args.evals.split(","), args.patch or None,
                      args.claim, args.run_id, args.approvals)
    fn = modal.Function.from_name(APP_NAME, CONTROLLER_FUNCTION)
    call = fn.spawn(spec)
    print(f"run  : {spec['run']}")
    print(f"call : {call.object_id}")
    if args.wait:
        report = call.get()
        v = report["verdict"]
        print(f"\nverdict: {v['verdict']}")
        for c in v["checks"]:
            print(f"  {c['eval']}/{c['metric']}: "
                  f"{c.get('delta_pct', c.get('cand'))} "
                  f"(limit {c['threshold']}) violated={c['violated']}")
        print("\n" + report["pr_comment_md"])


if __name__ == "__main__":
    main()
