"""Eval-spec validation shared by every writer: the store routes (api/evals),
run creation (api/api extra_evals), and the session agent's draft_eval. One
set of rules so an eval that passes anywhere passes everywhere.

Two layers:
- validate_eval: the base schema every eval meets (name, cmd with {out},
  known metrics, threshold formats). Raises ValueError with a user-facing
  message.
- validate_scoped: the extra constraints on agent-proposed scoped evals —
  they may only parameterize a declared measurement harness (a cmd prefix
  taken from the repo's own suite, or the platform bench) with allowlisted,
  ceiling-bounded knobs. The agent cannot invent arbitrary commands.
"""
import re
import shlex

KNOWN_METRICS = ("tokens_per_s", "latency_ms_median", "latency_ms_p95",
                 "peak_vram_mb")
REL_RE = re.compile(r"^[+-]\d+(\.\d+)?%$")
ABS_RE = re.compile(r"^(<=|>=|<|>)\d+(\.\d+)?$")
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,40}$")

# The harness every demo image ships; the fallback when a repo declares no
# evals yet (the zero-eval case must still allow a constrained proposal).
PLATFORM_HARNESS = "python /harness/bench.py"

SCOPED_KNOBS = ("src", "eval", "out", "tokens", "batch", "repeats")
# Tighter than the investigator's probe ceilings on purpose: a scoped eval
# rides a full review, so it stays cheap.
SCOPED_CEILINGS = {"tokens": 512, "batch": 8, "repeats": 7}
SCOPED_PER_RUN_MAX = 2


def validate_eval(body: dict) -> dict:
    """Base schema -> normalized entry. Raises ValueError on any violation."""
    name = body.get("name") or ""
    if not NAME_RE.fullmatch(name):
        raise ValueError("eval name: lowercase letters, digits, _")
    cmd = (body.get("cmd") or "").strip()
    if not cmd or "{out}" not in cmd:
        raise ValueError("cmd required and must contain {out}")
    checks = body.get("checks") or {}
    absolute = body.get("absolute") or {}
    if not checks and not absolute:
        raise ValueError("at least one check or absolute required")
    for metric, thr in checks.items():
        if metric not in KNOWN_METRICS:
            raise ValueError(f"unknown metric: {metric}")
        if not isinstance(thr, str) or not REL_RE.fullmatch(thr):
            raise ValueError(f"bad relative threshold for {metric}: "
                             f"{thr!r} (form: \"-10%\" / \"+15%\")")
    for metric, expr in absolute.items():
        if metric not in KNOWN_METRICS:
            raise ValueError(f"unknown metric: {metric}")
        if not isinstance(expr, str) or not ABS_RE.fullmatch(expr):
            raise ValueError(f"bad absolute bound for {metric}: "
                             f"{expr!r} (form: \"<3000\")")
    entry = {"name": name, "cmd": cmd, "checks": checks}
    if absolute:
        entry["absolute"] = absolute
    if body.get("origin"):
        entry["origin"] = body["origin"]
    return entry


def harness_prefixes(suite: list[dict]) -> set[str]:
    """The declared harness invocations: each suite cmd up to its first flag,
    plus the platform bench so an empty suite still has one legal harness."""
    out = {PLATFORM_HARNESS}
    for ev in suite:
        cmd = (ev.get("cmd") or "").strip()
        if " --" in cmd:
            out.add(cmd.split(" --", 1)[0].strip())
        elif cmd:
            out.add(cmd)
    return out


def validate_scoped(entry: dict, suite: list[dict]) -> None:
    """Scoped-eval constraints on top of validate_eval. Raises ValueError."""
    cmd = entry["cmd"]
    prefixes = harness_prefixes(suite)
    prefix = cmd.split(" --", 1)[0].strip() if " --" in cmd else cmd
    if prefix not in prefixes:
        raise ValueError(
            f"scoped eval must invoke a declared harness ({sorted(prefixes)}); "
            f"got {prefix!r}")
    if "{src}" not in cmd:
        raise ValueError("scoped eval cmd must contain {src}")
    try:
        toks = shlex.split(cmd)
    except ValueError as e:
        raise ValueError(f"unparseable cmd: {e}")
    i = 0
    while i < len(toks):
        t = toks[i]
        if t.startswith("--"):
            key = t[2:].split("=", 1)[0]
            if key not in SCOPED_KNOBS:
                raise ValueError(f"scoped eval flag --{key} not allowed; "
                                 f"allowed: {list(SCOPED_KNOBS)}")
            val = t.split("=", 1)[1] if "=" in t else (
                toks[i + 1] if i + 1 < len(toks) else "")
            if key in SCOPED_CEILINGS:
                try:
                    n = int(val)
                except ValueError:
                    raise ValueError(f"--{key} needs an integer, got {val!r}")
                if not 1 <= n <= SCOPED_CEILINGS[key]:
                    raise ValueError(f"--{key} {n} outside 1..{SCOPED_CEILINGS[key]}")
            if "=" not in t:
                i += 1
        i += 1
