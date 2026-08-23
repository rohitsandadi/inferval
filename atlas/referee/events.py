"""events.jsonl append helper. Used by controller/runner; UI reads via API."""
import datetime
import json
import os


def append_event(runs_root: str, run_id: str, tier: str, kind: str,
                 detail: dict, refs: list[str] | None = None) -> dict:
    e = {"t": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
         "run": run_id, "tier": tier, "kind": kind, "detail": detail}
    if refs:
        e["refs"] = refs
    d = os.path.join(runs_root, run_id)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "events.jsonl"), "a") as f:
        f.write(json.dumps(e) + "\n")
    return e
