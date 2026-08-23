"""Materialize immutable revisions inside the sandbox. Same clone commands
as scripts/manual_paired_run.py."""
from atlas.runner.sandbox_mgr import sh


def materialize(sb, repo_url: str, sha: str, dest: str) -> str:
    """Clone + checkout; returns the SHA actually checked out."""
    sh(sb, f"git clone -q {repo_url} {dest} && cd {dest} && git checkout -q {sha}")
    _, out, _ = sh(sb, f"cd {dest} && git rev-parse HEAD")
    return out.strip()


def apply_patch(sb, dest: str, patch_path: str) -> None:
    """Apply a demo patch (mounted under /harness/patches/) to a tree."""
    sh(sb, f"cd {dest} && git apply {patch_path}")
