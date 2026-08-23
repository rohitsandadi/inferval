#!/usr/bin/env python
"""Session live smoke: real GitHub fetch, real ox-alpha, real Modal sandboxes.

Creates a session attached to PR #1 of rohitsandadi/nanoGPT, then runs two
turns LOCALLY (the loop may create real Modal sandboxes and calls OpenRouter
from this machine):

  turn 1: "What does this PR change and how should we test it?"
          PASS = triage.json with >=2 annotations citing real model.py line
          ranges, coverage referencing generate_short/generate_long, thinking
          events streamed, agent_message present, no crash.
  turn 2: "run the cheapest check that would confirm the perf risk"
          The agent decides an environment and either creates a real sandbox
          and execs something small, or explains and submits a review —
          either is acceptable. Budget ~$0.20 GPU max; any sandbox this
          script created is terminated at exit (the product leaves cooldown
          reaping to the registry; the smoke pays for nothing idle).

The OpenRouter key is loaded from openrouter.env into the process
env only; it is never printed or written anywhere.

Usage: .venv/bin/python scripts/session_smoke.py [--turn1-only]
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REPO = "rohitsandadi/nanoGPT"
TURN1 = "What does this PR change and how should we test it?"
TURN2 = "run the cheapest check that would confirm the perf risk"


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


def dump_events(root, cid, since=0):
    p = os.path.join(root, "chats", cid, "events.jsonl")
    lines = open(p).read().splitlines() if os.path.exists(p) else []
    for line in lines[since:]:
        print("  " + line)
    return len(lines)


def main():
    load_env()
    root = tempfile.mkdtemp(prefix="session_smoke_")
    os.environ["ATLAS_RUNS_ROOT"] = root
    print(f"runs root: {root}")

    from fastapi.testclient import TestClient
    from atlas.api import api
    from atlas.session import tools as stools
    from atlas.session.loop import run_turn

    client = TestClient(api.web_app)

    # --- create the session (real GitHub fetch) -----------------------------
    t0 = time.time()
    r = client.post(f"/api/repos/{REPO}/sessions", json={"pr": 1})
    assert r.status_code == 200, r.text
    cid = r.json()["session"]
    meta = json.load(open(os.path.join(root, "chats", cid, "meta.json")))
    diff = open(os.path.join(root, "chats", cid, "pr.diff")).read()
    print(f"session {cid} created in {time.time() - t0:.1f}s")
    print(f"  pr: #{meta['pr']['number']} {meta['pr']['title']!r}")
    print(f"  base {meta['pr']['base']} -> head {meta['pr']['head']}; "
          f"branch {meta['branch']}; diff {len(diff)}B")

    # any sandbox created for real gets terminated at exit (budget guard)
    created = []

    def factory(ctx, kind, gpu):
        sb, sid = stools._default_sandbox_factory(ctx, kind, gpu)
        created.append(sb)
        return sb, sid

    failures = []
    try:
        # --- turn 1 ---------------------------------------------------------
        print(f"\n=== turn 1: {TURN1!r}")
        t0 = time.time()
        res = run_turn(cid, root, TURN1, sandbox_factory=factory)
        print(f"turn 1 done in {time.time() - t0:.0f}s -> {res}")
        n_events = dump_events(root, cid)

        tri_path = os.path.join(root, "chats", cid, "triage.json")
        tri = json.load(open(tri_path)) if os.path.exists(tri_path) else []
        events = [json.loads(l) for l in
                  open(os.path.join(root, "chats", cid, "events.jsonl"))]
        kinds = [e["kind"] for e in events]
        cov = {n for a in tri if isinstance(a.get("coverage"), list)
               for n in a["coverage"]}
        checks = [
            ("turn ok (no crash)", res["ok"]),
            (">=2 annotations", len(tri) >= 2),
            (">=2 cite model.py line ranges",
             sum(1 for a in tri if a["path"].endswith("model.py")
                 and a["start_line"] > 0) >= 2),
            ("coverage references generate_short/long",
             bool(cov & {"generate_short", "generate_long"})),
            ("thinking events streamed", kinds.count("thinking") >= 1),
            ("agent_message present", "agent_message" in kinds),
            ("triage event present", "triage" in kinds),
        ]
        print("\nturn 1 checks:")
        for name, ok in checks:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
            if not ok:
                failures.append(f"turn1: {name}")
        print("\ntriage annotations (verbatim):")
        for a in tri:
            print("  " + json.dumps(a))

        if "--turn1-only" in sys.argv:
            return

        # --- turn 2 ---------------------------------------------------------
        print(f"\n=== turn 2: {TURN2!r}")
        t0 = time.time()
        res2 = run_turn(cid, root, TURN2, sandbox_factory=factory)
        print(f"turn 2 done in {time.time() - t0:.0f}s -> {res2}")
        print("\nturn 2 events (verbatim):")
        dump_events(root, cid, since=n_events)
        if not res2["ok"]:
            failures.append("turn2: turn errored")

        detail = client.get(f"/api/sessions/{cid}").json()
        print(f"\nsession detail: status={detail['status']} "
              f"drafts={len(detail['drafts'])} "
              f"triage={len(detail['triage'] or [])} annotations")
    finally:
        for sb in created:
            try:
                sb.terminate()
                print(f"terminated smoke sandbox {sb.object_id}")
            except Exception:
                pass

    print("\n" + ("SMOKE FAIL: " + "; ".join(failures) if failures
                  else "SMOKE PASS"))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
