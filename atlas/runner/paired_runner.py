"""The paired measurement protocol, productizing scripts/manual_paired_run.py
exactly: interleaved base-head-head-base, one sb.exec per block (fresh process
= fresh CUDA context), same bench.py flags.

A bench crash becomes a failed BlockResult — data for the referee — never a
runner exception. run_blocks() is also the probe entry point for the
investigator (a probe IS a paired run with modified params, written under
experiments/<eid>/).
"""
import json
import shlex

from atlas.contracts.names import WEIGHTS_PATH
from atlas.runner import artifacts
from atlas.runner.sandbox_mgr import sh

BLOCK_TIMEOUT = 600
PREFLIGHT_TIMEOUT = 240
COMPARE_ORDER = ["base", "head", "head", "base"]
CHECK_ORDER = ["base"]

TELEMETRY_INTERVAL_S = 1
TELEMETRY_QUERY = "utilization.gpu,memory.used,power.draw"


def parse_telemetry(text: str,
                    interval_s: int = TELEMETRY_INTERVAL_S) -> dict | None:
    """nvidia-smi csv,noheader,nounits lines -> the wireframe's shape.
    Malformed lines are skipped whole (arrays stay parallel); no valid
    samples -> None (caller writes no file)."""
    util, mem, power = [], [], []
    for line in text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3:
            continue
        try:
            u, m, w = int(float(parts[0])), int(float(parts[1])), float(parts[2])
        except ValueError:
            continue
        util.append(u)
        mem.append(m)
        power.append(w)
    if not util:
        return None
    return {"interval_s": interval_s, "util_gpu": util, "mem_mb": mem,
            "power_w": power}


def start_telemetry(sb, tmp: str):
    """Background 1 Hz nvidia-smi sampler writing to a sandbox tmp file.
    Returns the sampler pid, or None on any failure — never raises."""
    try:
        cmd = (f"rm -f {tmp}; nohup nvidia-smi --query-gpu={TELEMETRY_QUERY} "
               f"--format=csv,noheader,nounits -l {TELEMETRY_INTERVAL_S} "
               f"> {tmp} 2>/dev/null & echo $!")
        rc, out, _ = sh(sb, cmd, check=False, timeout=30)
        pid = out.strip().splitlines()[-1].strip() if rc == 0 and out.strip() else ""
        return pid if pid.isdigit() else None
    except Exception:
        return None


def stop_telemetry(sb, pid: str, tmp: str) -> dict | None:
    """Kill the sampler, read + parse its samples, clean up. None on any
    failure — never raises."""
    try:
        sh(sb, f"kill {pid} >/dev/null 2>&1 || true", check=False, timeout=30)
        rc, text, _ = sh(sb, f"cat {tmp}; rm -f {tmp}", check=False, timeout=30)
        return parse_telemetry(text) if rc == 0 else None
    except Exception:
        return None


def params_from_cmd(cmd: str) -> dict:
    """Pull --tokens/--batch/--repeats out of the eval's declared cmd."""
    toks = shlex.split(cmd)
    params = {"tokens": 128, "batch": 2, "repeats": 5}
    for i, t in enumerate(toks[:-1]):
        key = t.lstrip("-")
        if t.startswith("--") and key in params:
            params[key] = int(toks[i + 1])
    return params


def bench_cmd(run_id: str, label: str, block: int, eval_name: str,
              params: dict, out: str, profile: bool = False) -> str:
    """The manual_paired_run.py invocation (known-good), with per-run clone
    dirs (/work/<run_id>/<label>) so a warm, reused sandbox never shares
    trees between runs."""
    prof = " --profile" if profile else ""
    return (f"python /harness/bench.py --src /work/{run_id}/{label} "
            f"--label {label} --block {block} --eval {eval_name} "
            f"--tokens {params['tokens']} --batch {params['batch']} "
            f"--repeats {params['repeats']} "
            f"--weights {WEIGHTS_PATH} "
            f"--prompts /harness/prompts.json --out {out}{prof}")


def failed_block(label: str, block: int, eval_name: str, params: dict,
                 rc: int, stderr: str) -> dict:
    """Synthesized BlockResult when exec died with no JSON on disk."""
    return {"schema": "1", "status": "failed", "label": label, "block": block,
            "eval": eval_name, "params": params, "samples": {},
            "timing": "n/a", "env": {},
            "error": f"bench exec failed (returncode {rc})",
            "traceback": (stderr or "")[-2000:]}


def exec_block(sb, run_id: str, label: str, block: int, eval_name: str,
               params: dict, subdir: str, profile: bool = False,
               timeout: int = BLOCK_TIMEOUT, volume=None,
               telemetry: bool = False) -> dict:
    """One bench process; result JSON read back via cat (the known-good path)
    and persisted controller-side — never trusting sandbox commit timing.
    With telemetry=True, a 1 Hz GPU sampler runs alongside the bench; any
    telemetry failure degrades to no .telemetry.json, never an exception."""
    out = f"/runs/{run_id}/{subdir}/b{block}_{label}_{eval_name}.json"
    tel_tmp = f"/tmp/atlas_tel_{run_id}_b{block}_{label}.csv"
    tel_pid = start_telemetry(sb, tel_tmp) if telemetry else None
    rc, err, result = -1, "", None
    try:
        rc, _, err = sh(sb, bench_cmd(run_id, label, block, eval_name, params,
                                      out, profile), check=False,
                        timeout=timeout)
        crc, text, _ = sh(sb, f"cat {out}", check=False)
        if crc == 0:
            result = json.loads(text)
    except Exception as e:  # timeout / transport failure / bad JSON
        err = err or str(e)
    if tel_pid is not None:
        tel = stop_telemetry(sb, tel_pid, tel_tmp)
        if tel is not None:
            try:
                artifacts.write_json(
                    artifacts.telemetry_path(run_id, subdir, block, label,
                                             eval_name), tel, volume)
            except Exception:
                pass  # telemetry must never break a run
    if result is None:
        result = failed_block(label, block, eval_name, params, rc, err)
    artifacts.write_json(
        artifacts.block_path(run_id, subdir, block, label, eval_name),
        result, volume)
    return result


def preflight(sb, run_spec: dict, volume=None) -> list[dict]:
    """Cheap sanity pass (8 tokens, 1 repeat) on each tree. Failures become
    failed BlockResults the referee can rule on."""
    params = {"tokens": 8, "batch": 2, "repeats": 1}
    labels = ["base", "head"] if run_spec["mode"] == "compare" else ["base"]
    sh(sb, f"mkdir -p /runs/{run_spec['run']}/preflight")
    return [exec_block(sb, run_spec["run"], lb, i, "preflight", params,
                       "preflight", timeout=PREFLIGHT_TIMEOUT, volume=volume)
            for i, lb in enumerate(labels)]


def run_blocks(sb, run_spec: dict, eval_spec: dict, overrides=None,
               out_subdir: str = "blocks", profile: bool = False,
               volume=None, on_block=None) -> list[dict]:
    """One paired measurement for one eval. The investigator's probes call
    this with overrides and out_subdir="experiments/<eid>"."""
    params = params_from_cmd(eval_spec["cmd"])
    params.update(overrides or {})
    order = COMPARE_ORDER if run_spec["mode"] == "compare" else CHECK_ORDER
    sh(sb, f"mkdir -p /runs/{run_spec['run']}/{out_subdir}")
    results = []
    for i, label in enumerate(order):
        prof = profile and i in (0, 1)  # one base + one head, as in manual run
        r = exec_block(sb, run_spec["run"], label, i, eval_spec["name"],
                       params, out_subdir, profile=prof, volume=volume,
                       telemetry=True)
        results.append(r)
        if on_block:
            on_block(r)
    return results
