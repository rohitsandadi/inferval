"""M1 unit tests: pure logic, no Modal. The sandbox is a stub."""
import json
import os

import pytest

from atlas.contracts.names import ENV_RUNS_ROOT
from atlas.runner import artifacts, paired_runner

SPEC = {"schema": "1", "run": "t_run", "mode": "compare", "repo": "x",
        "base_sha": "a", "head_sha": "b", "gpu": "A10G", "image": "img",
        "selection": "all", "approvals": "auto",
        "evals": [{"name": "gen", "cmd": "python /harness/bench.py --src {src} "
                   "--eval gen --tokens 128 --batch 2 --repeats 5 --out {out}",
                   "checks": {"tokens_per_s": "-10%"}}]}


class _Stream:
    def __init__(self, s):
        self.s = s

    def read(self):
        return self.s


class _Proc:
    def __init__(self, rc, out="", err=""):
        self.returncode = rc
        self.stdout = _Stream(out)
        self.stderr = _Stream(err)

    def wait(self):
        return self.returncode


class StubSandbox:
    """Replays scripted (rc, stdout, stderr) per command; records commands."""

    def __init__(self, script):
        self.script = script  # callable: cmd -> (rc, out, err)
        self.cmds = []

    def exec(self, *args, timeout=None, **kw):
        cmd = args[-1]
        self.cmds.append(cmd)
        return _Proc(*self.script(cmd))


def good_json(label, block):
    return json.dumps({"schema": "1", "status": "completed", "label": label,
                       "block": block, "eval": "gen", "params": {},
                       "samples": {"tokens_per_s": [400.0]},
                       "summary": {"tokens_per_s": 400.0,
                                   "latency_ms_median": 300.0,
                                   "latency_ms_p95": 310.0,
                                   "peak_vram_mb": 1900.0},
                       "output_ids": [[1, 2]], "outputs_consistent": True,
                       "timing": "cuda_sync_wall", "env": {}})


def happy_script(cmd):
    if cmd.startswith("cat "):
        path = cmd.split()[-1]
        name = os.path.basename(path)  # b{i}_{label}_{eval}.json
        i, label = name.split("_")[0][1:], name.split("_")[1]
        return (0, good_json(label, int(i)), "")
    return (0, "", "")


@pytest.fixture
def runs_root(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_RUNS_ROOT, str(tmp_path))
    return tmp_path


def test_block_order_compare(runs_root):
    sb = StubSandbox(happy_script)
    blocks = paired_runner.run_blocks(sb, SPEC, SPEC["evals"][0])
    assert [b["label"] for b in blocks] == ["base", "head", "head", "base"]
    assert [b["block"] for b in blocks] == [0, 1, 2, 3]
    bench = [c for c in sb.cmds if c.startswith("python /harness/bench.py")]
    # per-run clone dirs: reused warm sandboxes never share trees
    assert "--src /work/t_run/base" in bench[0]
    assert "--src /work/t_run/head" in bench[1]
    assert "--weights /cache/gpt2_124m.pt" in bench[0]
    assert "--prompts /harness/prompts.json" in bench[0]
    # persisted controller-side under the run dir
    for i, label in enumerate(["base", "head", "head", "base"]):
        assert (runs_root / "t_run" / "blocks"
                / f"b{i}_{label}_gen.json").exists()


def test_check_mode_single_block(runs_root):
    sb = StubSandbox(happy_script)
    spec = {**SPEC, "mode": "check"}
    blocks = paired_runner.run_blocks(sb, spec, SPEC["evals"][0])
    assert [b["label"] for b in blocks] == ["base"]


def test_failed_exec_synthesized(runs_root):
    def script(cmd):
        if cmd.startswith("python"):
            return (137, "", "CUDA error: out of memory\n")
        if cmd.startswith("cat"):
            return (1, "", "No such file")
        return (0, "", "")
    sb = StubSandbox(script)
    blocks = paired_runner.run_blocks(sb, SPEC, SPEC["evals"][0])
    assert all(b["status"] == "failed" for b in blocks)
    b0 = blocks[0]
    assert "137" in b0["error"]
    assert "out of memory" in b0["traceback"]
    assert b0["label"] == "base" and b0["eval"] == "gen"
    # the failure is still persisted as evidence
    assert (runs_root / "t_run" / "blocks" / "b0_base_gen.json").exists()


def test_bench_own_failed_json_passes_through(runs_root):
    failed = json.dumps({"schema": "1", "status": "failed", "label": "base",
                         "block": 0, "eval": "gen", "params": {},
                         "samples": {}, "timing": "n/a", "env": {},
                         "error": "boom", "traceback": "tb"})

    def script(cmd):
        if cmd.startswith("python"):
            return (1, "", "")
        if cmd.startswith("cat"):
            return (0, failed, "")
        return (0, "", "")
    sb = StubSandbox(script)
    spec = {**SPEC, "mode": "check"}
    blocks = paired_runner.run_blocks(sb, spec, SPEC["evals"][0])
    assert blocks[0]["error"] == "boom"  # bench's JSON, not a synthesized one


def test_params_from_cmd_and_overrides(runs_root):
    p = paired_runner.params_from_cmd(SPEC["evals"][0]["cmd"])
    assert p == {"tokens": 128, "batch": 2, "repeats": 5}
    sb = StubSandbox(happy_script)
    paired_runner.run_blocks(sb, {**SPEC, "mode": "check"}, SPEC["evals"][0],
                             overrides={"repeats": 2, "batch": 1})
    bench = [c for c in sb.cmds if c.startswith("python")][0]
    assert "--repeats 2" in bench and "--batch 1" in bench and "--tokens 128" in bench


def test_profile_flag_on_first_pair(runs_root):
    sb = StubSandbox(happy_script)
    paired_runner.run_blocks(sb, SPEC, SPEC["evals"][0], profile=True)
    bench = [c for c in sb.cmds if c.startswith("python")]
    assert bench[0].endswith("--profile") and bench[1].endswith("--profile")
    assert not bench[2].endswith("--profile")
    assert not bench[3].endswith("--profile")


def test_preflight_labels(runs_root):
    sb = StubSandbox(happy_script)
    blocks = paired_runner.preflight(sb, SPEC)
    assert [b["label"] for b in blocks] == ["base", "head"]
    bench = [c for c in sb.cmds if c.startswith("python")]
    assert "--tokens 8" in bench[0] and "--repeats 1" in bench[0]


def test_block_path(runs_root):
    p = artifacts.block_path("r1", "experiments/e2", 3, "head", "gen")
    assert p == str(runs_root / "r1" / "experiments" / "e2" / "b3_head_gen.json")


def test_telemetry_path(runs_root):
    p = artifacts.telemetry_path("r1", "blocks", 0, "base", "gen")
    assert p == str(runs_root / "r1" / "blocks" / "b0_base_gen.telemetry.json")


# --- GPU telemetry ----------------------------------------------------------

def test_parse_telemetry_shape_and_skips_malformed():
    text = ("45, 1024, 68.42\n"
            "not, a, line\n"          # non-numeric -> skipped whole
            "88, 2048\n"              # short line -> skipped
            "97, 2050, 71.10\n"
            "\n")
    t = paired_runner.parse_telemetry(text)
    assert t == {"interval_s": 1, "util_gpu": [45, 97],
                 "mem_mb": [1024, 2050], "power_w": [68.42, 71.10]}
    assert len(t["util_gpu"]) == len(t["mem_mb"]) == len(t["power_w"])


def test_parse_telemetry_no_samples_is_none():
    assert paired_runner.parse_telemetry("") is None
    assert paired_runner.parse_telemetry("garbage\nN/A, N/A, N/A\n") is None


def telemetry_script(csv_text):
    """happy_script plus a live nvidia-smi sampler (pid 4242)."""
    def script(cmd):
        if "nvidia-smi --query-gpu" in cmd:
            return (0, "4242\n", "")
        if cmd.startswith("kill 4242"):
            return (0, "", "")
        if cmd.startswith("cat /tmp/atlas_tel_"):
            return (0, csv_text, "")
        return happy_script(cmd)
    return script


def test_run_blocks_write_telemetry_next_to_blocks(runs_root):
    sb = StubSandbox(telemetry_script("50, 1900, 60.0\n70, 1950, 65.5\n"))
    paired_runner.run_blocks(sb, SPEC, SPEC["evals"][0])
    for i, label in enumerate(["base", "head", "head", "base"]):
        p = runs_root / "t_run" / "blocks" / f"b{i}_{label}_gen.telemetry.json"
        assert p.exists(), p
        t = json.loads(p.read_text())
        assert t == {"interval_s": 1, "util_gpu": [50, 70],
                     "mem_mb": [1900, 1950], "power_w": [60.0, 65.5]}
    # sampler runs at 1 Hz and is stopped after each block
    starts = [c for c in sb.cmds if "nvidia-smi --query-gpu" in c]
    assert len(starts) == 4 and all("-l 1" in c for c in starts)
    assert len([c for c in sb.cmds if c.startswith("kill 4242")]) == 4


def test_telemetry_start_failure_degrades_to_no_file(runs_root):
    def script(cmd):
        if "nvidia-smi --query-gpu" in cmd:
            return (1, "", "nvidia-smi: not found")  # sampler never starts
        return happy_script(cmd)
    sb = StubSandbox(script)
    blocks = paired_runner.run_blocks(sb, {**SPEC, "mode": "check"},
                                      SPEC["evals"][0])
    assert blocks[0]["status"] == "completed"  # bench unaffected
    assert (runs_root / "t_run" / "blocks" / "b0_base_gen.json").exists()
    assert not (runs_root / "t_run" / "blocks"
                / "b0_base_gen.telemetry.json").exists()


def test_telemetry_read_failure_degrades_to_no_file(runs_root):
    def script(cmd):
        if "nvidia-smi --query-gpu" in cmd:
            return (0, "4242\n", "")
        if cmd.startswith("cat /tmp/atlas_tel_"):
            return (1, "", "No such file")  # samples vanished
        return happy_script(cmd)
    sb = StubSandbox(script)
    blocks = paired_runner.run_blocks(sb, {**SPEC, "mode": "check"},
                                      SPEC["evals"][0])
    assert blocks[0]["status"] == "completed"
    assert not (runs_root / "t_run" / "blocks"
                / "b0_base_gen.telemetry.json").exists()


def test_preflight_skips_telemetry(runs_root):
    sb = StubSandbox(telemetry_script("50, 1900, 60.0\n"))
    paired_runner.preflight(sb, SPEC)
    assert not any("nvidia-smi --query-gpu" in c for c in sb.cmds)
    assert not (runs_root / "t_run" / "preflight"
                / "b0_base_preflight.telemetry.json").exists()
