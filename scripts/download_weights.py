"""One-time: cache GPT-2 124M weights (nanoGPT state_dict) into atlas-cache.

Run from atlas_v1/:  .venv/bin/modal run scripts/download_weights.py
CPU only; downloads from HF inside Modal, saves ~0.5GB to the Volume.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import modal
from atlas.runner.images import NANOGPT_SHA, NANOGPT_URL, TORCH_IMAGE
from atlas.runner.volumes import cache_volume

app = modal.App("atlas-setup")
cache = cache_volume()


@app.function(image=TORCH_IMAGE, volumes={"/cache": cache}, timeout=900)
def download_gpt2():
    import subprocess

    import torch

    dest = "/cache/gpt2_124m.pt"
    if os.path.exists(dest):
        print(f"already cached: {dest} ({os.path.getsize(dest)/1e6:.0f} MB)")
        return dest
    subprocess.run(["git", "clone", NANOGPT_URL, "/tmp/nanogpt"], check=True)
    subprocess.run(["git", "-C", "/tmp/nanogpt", "checkout", NANOGPT_SHA], check=True)
    sys.path.insert(0, "/tmp/nanogpt")
    from model import GPT

    model = GPT.from_pretrained("gpt2")
    torch.save(model.state_dict(), dest)
    cache.commit()
    print(f"saved {dest} ({os.path.getsize(dest)/1e6:.0f} MB)")
    return dest


@app.local_entrypoint()
def main():
    print(download_gpt2.remote())
