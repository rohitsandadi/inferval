"""Atlas contracts. Plain TypedDicts, no ceremony.

These mirror v2/ARCHITECTURE.md section 4. Every module codes against these
and the JSON fixtures in atlas/fixtures/. Amendments require one commit that
all four owners see.
"""
from typing import Any, Literal, NotRequired, TypedDict

SCHEMA_VERSION = "1"

Tier = Literal["system", "policy", "agent", "human"]
VerdictKind = Literal["pass", "regression", "invalid"]
Mode = Literal["compare", "check"]


class Event(TypedDict):
    """One line of events.jsonl — the shared feed for the UI and investigator."""
    t: str            # ISO timestamp
    run: str          # run id
    tier: Tier
    kind: str         # open enum; UI renders unknown kinds generically
    detail: dict[str, Any]
    refs: NotRequired[list[str]]  # artifact paths backing this event


class EvalSpec(TypedDict):
    """One eval from atlas.yaml."""
    name: str
    cmd: str                          # bench command template, {out} placeholder
    checks: dict[str, str]            # compare mode: metric -> "+15%" / "-10%"
    absolute: NotRequired[dict[str, str]]  # check mode: metric -> "<50"


class RunSpec(TypedDict):
    """Frozen definition of one run."""
    schema: str
    run: str
    mode: Mode
    repo: str                 # git URL
    base_sha: str
    head_sha: NotRequired[str]  # absent in check mode
    gpu: str
    image: str
    evals: list[EvalSpec]      # the evals this run will execute (post-plan)
    selection: Literal["all", "pick", "auto"]
    claim: NotRequired[str]    # PR claim text, when known
    approvals: Literal["auto", "manual"]
    overrides: NotRequired[list[str]]  # legal probe switches, from atlas.yaml
    branch: NotRequired[str]           # display only (runs table, run page)


class BenchSummary(TypedDict):
    tokens_per_s: float        # median across repeats
    latency_ms_median: float   # whole-generate wall, per repeat
    latency_ms_p95: float
    peak_vram_mb: float


class BlockResult(TypedDict):
    """Output of one bench.py invocation (one block). The M1 -> M2 seam."""
    schema: str
    status: Literal["completed", "failed"]
    label: str                 # "base" | "head"
    block: int                 # block index in run order
    eval: str                  # eval name
    params: dict[str, Any]     # tokens, batch, seed, ...
    samples: dict[str, list[float]]  # raw per-repeat values per metric
    summary: NotRequired[BenchSummary]
    output_ids: NotRequired[list[list[int]]]  # generated token ids per prompt
    outputs_consistent: NotRequired[bool]     # repeats produced identical ids
    timing: str                # "cuda_sync_wall"
    env: dict[str, Any]        # torch version, gpu name, sha label
    profile: NotRequired[dict[str, Any]]      # present with --profile
    error: NotRequired[str]
    traceback: NotRequired[str]


class CheckResult(TypedDict):
    metric: str
    eval: str
    base: NotRequired[float]
    cand: float
    delta_pct: NotRequired[float]
    threshold: str
    violated: bool
    flagged: NotRequired[bool]   # near the noise band -> highlight, not verdict


class Verdict(TypedDict):
    schema: str
    run: str
    verdict: VerdictKind
    checks: list[CheckResult]
    correctness: dict[str, Any]  # {"result": "match"|"mismatch"|"n/a", ...}
    claim: NotRequired[dict[str, Any]]  # {"text": ..., "verified": bool|None}
    invalid_reason: NotRequired[str]


class Proposal(TypedDict):
    id: str
    kind: Literal["confirm_pair", "profile_pair", "override_pair"]
    params: dict[str, Any]
    reason: str
    est_gpu_seconds: float
    status: Literal["proposed", "approved", "denied", "expired", "done"]


class Observation(TypedDict):
    id: str
    text: str
    refs: list[str]


class Hypothesis(TypedDict):
    id: str
    text: str
    status: Literal["supported", "rejected", "inconclusive"]
    refs: list[str]


class Investigation(TypedDict):
    schema: str
    run: str
    status: Literal["not_needed", "completed", "inconclusive", "failed"]
    plan: NotRequired[dict[str, Any]]   # {"evals": [...], "extra_metrics": [...], "reasoning": ...}
    observations: list[Observation]
    hypotheses: list[Hypothesis]
    proposals: list[Proposal]
    diagnosis: NotRequired[dict[str, Any]]  # {"text": ..., "confidence": "low|medium|high"}
    fix_context: NotRequired[dict[str, Any]]


class Report(TypedDict):
    """What the UI's report section and the PR comment render from."""
    schema: str
    run: str
    verdict: Verdict
    summary: list[str]           # short findings, human sentences
    flagged: list[str]
    investigation: NotRequired[Investigation]
    pr_comment_md: str
