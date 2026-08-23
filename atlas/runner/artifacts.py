"""Run-dir helpers: paths per the layout in contracts/names.py, JSON writes
with volume commit, event appends. volume=None means local (tests)."""
import json
import os

from atlas.contracts.names import ENV_RUNS_ROOT
from atlas.referee.events import append_event


def runs_root() -> str:
    return os.environ.get(ENV_RUNS_ROOT, "/runs")


def run_dir(run_id: str) -> str:
    return os.path.join(runs_root(), run_id)


def block_path(run_id: str, subdir: str, block: int, label: str,
               eval_name: str) -> str:
    return os.path.join(run_dir(run_id), subdir,
                        f"b{block}_{label}_{eval_name}.json")


def telemetry_path(run_id: str, subdir: str, block: int, label: str,
                   eval_name: str) -> str:
    """GPU telemetry sits next to its block JSON: <block>.telemetry.json."""
    return os.path.join(run_dir(run_id), subdir,
                        f"b{block}_{label}_{eval_name}.telemetry.json")


def write_json(path: str, obj: dict, volume=None) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)
    if volume is not None:
        volume.commit()
    return path


def event(run_id: str, tier: str, kind: str, detail: dict,
          refs: list[str] | None = None, volume=None) -> dict:
    e = append_event(runs_root(), run_id, tier, kind, detail, refs)
    if volume is not None:
        volume.commit()
    return e
