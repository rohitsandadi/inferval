"""Metric registry and threshold parsing. Pure functions, zero Modal."""
from typing import Literal

Direction = Literal["higher", "lower"]

# Every metric the comparator understands. direction: which way is better.
# source: key in BlockResult["samples"], falling back to per-block
# BlockResult["summary"] (the harness emits e.g. latency_ms_p95 only there).
METRICS: dict[str, dict] = {
    "tokens_per_s": {"direction": "higher", "source": "tokens_per_s"},
    "latency_ms_median": {"direction": "lower", "source": "latency_ms_median"},
    "latency_ms_p95": {"direction": "lower", "source": "latency_ms_p95"},
    "peak_vram_mb": {"direction": "lower", "source": "peak_vram_mb"},
}

# Measured spread of the paired protocol on our scenario. OVERWRITE with the
# real number from tonight's noise run (scripts/manual_paired_run.py --mode noise).
NOISE_MARGIN_PCT = 3.0


def parse_relative(threshold: str) -> float:
    """'-10%' -> -10.0 ; '+15%' -> 15.0. Sign = allowed worsening direction."""
    return float(threshold.rstrip("%"))


def parse_absolute(expr: str) -> tuple[str, float]:
    """'<50' -> ('<', 50.0); supports < <= > >=."""
    for op in ("<=", ">=", "<", ">"):
        if expr.startswith(op):
            return op, float(expr[len(op):])
    raise ValueError(f"bad absolute check: {expr}")


def relative_violated(metric: str, delta_pct: float, threshold: str) -> bool:
    thr = parse_relative(threshold)
    direction = METRICS[metric]["direction"]
    if direction == "higher":   # e.g. tokens_per_s with "-10%"
        return delta_pct < thr
    return delta_pct > thr      # e.g. latency with "+15%"


def near_band(delta_pct: float, threshold: str, margin: float = NOISE_MARGIN_PCT) -> bool:
    """True when the delta sits within the noise margin of the threshold line."""
    return abs(delta_pct - parse_relative(threshold)) <= margin


def absolute_violated(value: float, expr: str) -> bool:
    op, bound = parse_absolute(expr)
    return not {"<": value < bound, "<=": value <= bound,
                ">": value > bound, ">=": value >= bound}[op]
