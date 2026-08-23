"""Pinned Modal images. Built once, cached; never rebuilt at the event."""
import modal

NANOGPT_SHA = "3adf61e154c3fe3fca428ad6bc3818b27a3b8291"  # pinned demo revision
NANOGPT_URL = "https://github.com/karpathy/nanoGPT"

# One image for everything GPU-side: bench runs, weight download, probes.
# transformers is only used by the one-time weight download.
TORCH_IMAGE = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install("torch==2.8.0", "numpy<3", "transformers==4.44.2")
    # Modal 1.x does not auto-mount local packages; without this, remote
    # functions crash on `import atlas`.
    .add_local_python_source("atlas")
)


def harness_image(repo_root: str) -> modal.Image:
    """TORCH_IMAGE with the bench harness, prompts, and patches mounted.

    add_local_* mounts at container start (no rebuild on edit).
    """
    return (
        TORCH_IMAGE
        .add_local_file(f"{repo_root}/demo/bench.py", "/harness/bench.py")
        .add_local_file(f"{repo_root}/demo/prompts.json", "/harness/prompts.json")
        .add_local_dir(f"{repo_root}/demo/patches", "/harness/patches")
    )
