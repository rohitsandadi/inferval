"""GPU sandbox lifecycle. Invocation mirrors scripts/manual_paired_run.py,
the run validated on real A10Gs (noise floor 0.23%)."""
import modal

from atlas.contracts.names import APP_NAME
from atlas.runner.volumes import cache_volume, runs_volume

SANDBOX_TIMEOUT = 1800


def sh(sb, cmd: str, check: bool = True,
       timeout: int | None = None) -> tuple[int, str, str]:
    """One bash command in the sandbox -> (returncode, stdout, stderr)."""
    p = sb.exec("bash", "-c", cmd, timeout=timeout)
    out = p.stdout.read()
    err = p.stderr.read()
    p.wait()
    if check and p.returncode != 0:
        raise RuntimeError(f"cmd failed ({p.returncode}): {cmd}\n{out}\n{err}")
    return p.returncode, out, err


def create_sandbox(run_id: str, gpu: str, image: modal.Image) -> modal.Sandbox:
    app = modal.App.lookup(APP_NAME, create_if_missing=True)
    return modal.Sandbox.create(
        app=app,
        image=image,
        gpu=gpu,
        tags={"run_id": run_id},
        volumes={"/cache": cache_volume(), "/runs": runs_volume()},
        timeout=SANDBOX_TIMEOUT,
    )


def ready_check(sb) -> str:
    """Readiness = a real exec, not a sleep. Returns the GPU name."""
    _, out, _ = sh(sb, "nvidia-smi --query-gpu=name --format=csv,noheader")
    return out.strip()


def terminate(sb) -> None:
    try:
        sb.terminate()
    except Exception:
        pass  # already gone / timed out; nothing to leak
