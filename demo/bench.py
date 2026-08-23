"""Atlas bench harness for nanoGPT-style repos.

Runs INSIDE the sandbox. Owns measurement (CUDA-sync timing, seeds, peak-VRAM
reset, deterministic generation); Atlas owns orchestration and fairness.

Emits one BlockResult JSON (see atlas/contracts/types.py) to --out.
Never parses stdout for numbers; the JSON file is the contract.

Usage (in sandbox):
  python /harness/bench.py --src /work/base --label base --block 0 \
    --eval generate_short --tokens 128 --repeats 5 \
    --weights /cache/gpt2_124m.pt --prompts /harness/prompts.json \
    --out /runs/<id>/block_0_base.json

CPU smoke test (no GPU, no weights):
  python demo/bench.py --src <nanoGPT dir> --init random --device cpu \
    --tokens 8 --repeats 2 --out /tmp/smoke.json
"""
import argparse
import json
import statistics
import sys
import time
import traceback


def build_model(args, torch):
    sys.path.insert(0, args.src)
    from model import GPT, GPTConfig  # the repo under test

    if args.init == "random":
        cfg = GPTConfig(block_size=128, vocab_size=1000, n_layer=2, n_head=2,
                        n_embd=64, dropout=0.0, bias=True)
        model = GPT(cfg)
    else:
        cfg = GPTConfig(block_size=1024, vocab_size=50257, n_layer=12,
                        n_head=12, n_embd=768, dropout=0.0, bias=True)
        model = GPT(cfg)
        sd = torch.load(args.weights, map_location="cpu")
        model.load_state_dict(sd)
    model.eval()
    model.to(args.device)
    return model, cfg


def load_prompts(args, cfg, torch):
    if args.prompts:
        with open(args.prompts) as f:
            rows = json.load(f)["prompts"]
    else:  # smoke fallback
        rows = [[1, 2, 3, 4, 5, 6, 7, 8]]
    rows = [[t % cfg.vocab_size for t in r] for r in rows[: args.batch]]
    width = min(len(r) for r in rows)
    rows = [r[:width] for r in rows]  # rectangular batch
    return torch.tensor(rows, dtype=torch.long, device=args.device)


def sync(args, torch):
    if args.device == "cuda":
        torch.cuda.synchronize()


def one_generate(model, idx, args, torch):
    # top_k=1 => deterministic greedy regardless of device RNG. Correctness
    # is exact output-id match; perf regressions can't hide behind sampling.
    with torch.no_grad():
        out = model.generate(idx, max_new_tokens=args.tokens,
                             temperature=1.0, top_k=1)
    return out


def run(args):
    import torch
    torch.manual_seed(args.seed)

    model, cfg = build_model(args, torch)
    idx = load_prompts(args, cfg, torch)

    # warmup: kernels, allocator, autotune
    for _ in range(args.warmup):
        one_generate(model, idx[:, : min(8, idx.shape[1])], args, torch)
    sync(args, torch)

    walls, tps, peak_alloc, peak_res = [], [], [], []
    outputs = None
    consistent = True
    for _ in range(args.repeats):
        if args.device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        sync(args, torch)
        t0 = time.perf_counter()
        out = one_generate(model, idx, args, torch)
        sync(args, torch)
        wall = time.perf_counter() - t0
        walls.append(wall * 1000.0)
        tps.append(args.tokens * idx.shape[0] / wall)
        if args.device == "cuda":
            peak_alloc.append(torch.cuda.max_memory_allocated() / 1e6)
            peak_res.append(torch.cuda.max_memory_reserved() / 1e6)
        ids = out[:, idx.shape[1]:].tolist()
        if outputs is None:
            outputs = ids
        elif ids != outputs:
            consistent = False

    result = {
        "schema": "1",
        "status": "completed",
        "label": args.label,
        "block": args.block,
        "eval": args.eval,
        "params": {"tokens": args.tokens, "batch": idx.shape[0],
                   "prompt_len": idx.shape[1], "seed": args.seed,
                   "repeats": args.repeats, "warmup": args.warmup,
                   "init": args.init},
        "samples": {"latency_ms": walls, "tokens_per_s": tps,
                    "peak_vram_mb": peak_alloc, "peak_vram_reserved_mb": peak_res},
        "summary": {
            "tokens_per_s": statistics.median(tps),
            "latency_ms_median": statistics.median(walls),
            "latency_ms_p95": sorted(walls)[max(0, int(len(walls) * 0.95) - 1)],
            "peak_vram_mb": max(peak_alloc) if peak_alloc else 0.0,
        },
        "output_ids": outputs,
        "outputs_consistent": consistent,
        "timing": "cuda_sync_wall" if args.device == "cuda" else "wall",
        "env": {"torch": torch.__version__,
                "gpu": torch.cuda.get_device_name(0) if args.device == "cuda" else "cpu",
                "src": args.src},
    }

    if args.profile:
        from torch.profiler import ProfilerActivity, profile
        acts = [ProfilerActivity.CPU]
        if args.device == "cuda":
            acts.append(ProfilerActivity.CUDA)
        n = min(args.tokens, 32)
        with profile(activities=acts) as prof:
            with torch.no_grad():
                model.generate(idx, max_new_tokens=n, temperature=1.0, top_k=1)
        sync(args, torch)
        trace_path = args.out.rsplit(".", 1)[0] + "_trace.json"
        prof.export_chrome_trace(trace_path)
        events = prof.key_averages()
        total_cuda_us = sum(getattr(e, "self_device_time_total", 0) for e in events)
        total_cpu_us = sum(e.self_cpu_time_total for e in events)
        top = sorted(events, key=lambda e: -(e.self_cpu_time_total +
                     getattr(e, "self_device_time_total", 0)))[:12]
        result["profile"] = {
            "tokens": n,
            "total_cuda_ms": total_cuda_us / 1000.0,
            "total_cpu_ms": total_cpu_us / 1000.0,
            "trace": trace_path,
            "top_ops": [{"name": e.key,
                         "cpu_ms": e.self_cpu_time_total / 1000.0,
                         "cuda_ms": getattr(e, "self_device_time_total", 0) / 1000.0,
                         "count": e.count} for e in top],
        }
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--label", default="base")
    p.add_argument("--block", type=int, default=0)
    p.add_argument("--eval", default="generate_short")
    p.add_argument("--tokens", type=int, default=128)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--repeats", type=int, default=5)
    p.add_argument("--warmup", type=int, default=2)
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--weights", default=None)
    p.add_argument("--prompts", default=None)
    p.add_argument("--device", default="cuda")
    p.add_argument("--init", default="gpt2", choices=["gpt2", "random"])
    p.add_argument("--profile", action="store_true")
    p.add_argument("--out", required=True)
    args = p.parse_args()

    try:
        result = run(args)
    except Exception as e:  # crash becomes data, never a runner exception
        result = {"schema": "1", "status": "failed", "label": args.label,
                  "block": args.block, "eval": args.eval,
                  "params": vars(args), "samples": {},
                  "timing": "n/a", "env": {"src": args.src},
                  "error": str(e), "traceback": traceback.format_exc()}
    with open(args.out, "w") as f:
        json.dump(result, f)
    print(f"[bench] {result['status']} {args.label} block={args.block} "
          f"eval={args.eval} -> {args.out}")
    sys.exit(0 if result["status"] == "completed" else 1)


if __name__ == "__main__":
    main()
