"""Loose validation: required keys present, nothing more. No schema ceremony."""
from typing import Any

REQUIRED: dict[str, list[str]] = {
    "event": ["t", "run", "tier", "kind", "detail"],
    "run_spec": ["schema", "run", "mode", "repo", "base_sha", "gpu", "image", "evals", "selection", "approvals"],
    "block_result": ["schema", "status", "label", "block", "eval", "params", "samples", "timing", "env"],
    "verdict": ["schema", "run", "verdict", "checks", "correctness"],
    "investigation": ["schema", "run", "status", "observations", "hypotheses", "proposals"],
    "report": ["schema", "run", "verdict", "summary", "flagged", "pr_comment_md"],
    "proposal": ["id", "kind", "params", "reason", "est_gpu_seconds", "status"],
}


def validate(obj: dict[str, Any], kind: str) -> dict[str, Any]:
    """Return obj if it has the required keys for `kind`, else raise ValueError."""
    missing = [k for k in REQUIRED[kind] if k not in obj]
    if missing:
        raise ValueError(f"{kind} missing keys: {missing}")
    return obj
