"""The three probe shapes and their ceilings. Pure functions, zero Modal.

Validation bounds the agent, it does not script it: any parameters inside the
ceilings are the agent's call. The runner executes every shape through the
same paired protocol, so probe results stay comparable with the primary run.
"""
from typing import Any

KINDS = ("confirm_pair", "profile_pair", "override_pair")

CEILINGS = {
    "max_repeats": 10,          # per block
    "min_tokens": 8,
    "max_tokens": 1024,         # bench --tokens
    "max_profile_tokens": 256,  # keeps the trace under max_trace_mb
    "max_trace_mb": 50,
}

# Cost model for est_gpu_seconds (A10G, PIN.md wall times): a block is one
# fresh bench process (model load + measured repeats).
BLOCK_OVERHEAD_S = 12.0
TOKENS_PER_S_EST = 300.0
PROFILE_OVERHEAD_S = 8.0
TRACE_MB_PER_TOKEN = 0.15

# blocks per probe: confirm/override run paired abba, profile one per side
_BLOCKS = {"confirm_pair": 4, "profile_pair": 2, "override_pair": 4}


class ProbeError(ValueError):
    """Invalid probe parameters. Returned to the model as text, never raised past tools."""


def _int_in(params: dict, key: str, lo: int, hi: int, default: int | None) -> int | None:
    v = params.get(key, default)
    if v is None:
        return None
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise ProbeError(f"{key} must be an integer in [{lo}, {hi}], got {v!r}")
    return v


def validate_probe(kind: str, params: dict[str, Any], eval_names: list[str],
                   allowed_overrides: list[str]) -> tuple[dict[str, Any], float]:
    """Return (clean params, est_gpu_seconds) or raise ProbeError."""
    if kind not in KINDS:
        raise ProbeError(f"unknown probe kind {kind!r}; one of {list(KINDS)}")
    ev = params.get("eval")
    if ev not in eval_names:
        raise ProbeError(f"eval must be one of {eval_names}, got {ev!r}")
    clean: dict[str, Any] = {"eval": ev}

    if kind == "confirm_pair":
        clean["repeats"] = _int_in(params, "repeats", 1, CEILINGS["max_repeats"], 5)
        tokens = _int_in(params, "tokens", CEILINGS["min_tokens"], CEILINGS["max_tokens"], None)
        if tokens is not None:
            clean["tokens"] = tokens
        order = params.get("order", "abba")
        if order not in ("abba", "ab"):
            raise ProbeError(f"order must be 'abba' or 'ab', got {order!r}")
        clean["order"] = order
        blocks = 4 if order == "abba" else 2

    elif kind == "profile_pair":
        clean["tokens"] = _int_in(params, "tokens", CEILINGS["min_tokens"],
                                  CEILINGS["max_profile_tokens"], 32)
        if clean["tokens"] * TRACE_MB_PER_TOKEN > CEILINGS["max_trace_mb"]:
            raise ProbeError(f"trace would exceed {CEILINGS['max_trace_mb']}MB")
        clean["repeats"] = 1
        blocks = _BLOCKS[kind]

    else:  # override_pair
        ov = params.get("override")
        if ov not in allowed_overrides:
            raise ProbeError(f"override must be declared in the suite {allowed_overrides}, got {ov!r}")
        val = params.get("value")
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            raise ProbeError(f"value must be a number, got {val!r}")
        clean["override"] = ov
        clean["value"] = val
        clean["repeats"] = _int_in(params, "repeats", 1, CEILINGS["max_repeats"], 3)
        blocks = _BLOCKS[kind]

    est = blocks * (BLOCK_OVERHEAD_S
                    + clean.get("repeats", 1) * clean.get("tokens", 128) / TOKENS_PER_S_EST
                    + (PROFILE_OVERHEAD_S if kind == "profile_pair" else 0.0))
    return clean, round(est, 1)
