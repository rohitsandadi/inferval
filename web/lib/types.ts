// Mirrors inferval/contracts/types.py (ARCHITECTURE §4). Amendments happen there first.

export type Tier = "system" | "policy" | "agent" | "human";
export type VerdictKind = "pass" | "regression" | "invalid";
export type Mode = "compare" | "check";

export interface InfervalEvent {
  t: string; // ISO timestamp
  run: string;
  tier: Tier;
  kind: string; // open enum; unknown kinds render generically
  detail: Record<string, unknown>;
  refs?: string[]; // artifact paths backing this event
}

export interface EvalSpec {
  name: string;
  cmd: string;
  checks: Record<string, string>; // compare mode: metric -> "+15%" / "-10%"
  absolute?: Record<string, string>; // check mode: metric -> "<50"
}

// Per-repo eval store entry: overlays the seeded suite by name.
export interface StoredEval extends EvalSpec {
  origin?: string; // "pr:N" when gap-born; absent when created by hand
}

export interface RunSpec {
  schema: string;
  run: string;
  mode: Mode;
  repo: string; // git URL
  base_sha: string;
  head_sha?: string; // absent in check mode
  gpu: string;
  image: string;
  evals: EvalSpec[];
  selection: "all" | "pick" | "auto";
  claim?: string;
  approvals: "auto" | "manual";
  branch?: string; // UI extra, not in the frozen contract
}

export interface CheckResult {
  metric: string;
  eval: string;
  base?: number;
  cand: number;
  delta_pct?: number;
  threshold: string;
  violated: boolean;
  flagged?: boolean; // near the noise band -> highlight, not verdict
}

export interface Verdict {
  schema: string;
  run: string;
  verdict: VerdictKind;
  checks: CheckResult[];
  correctness: { result?: "match" | "mismatch" | "n/a"; [k: string]: unknown };
  claim?: { text?: string; verified?: boolean | null };
  invalid_reason?: string;
}

export interface Proposal {
  id: string;
  kind: "confirm_pair" | "profile_pair" | "override_pair";
  params: Record<string, unknown>;
  reason: string;
  est_gpu_seconds: number;
  status: "proposed" | "approved" | "denied" | "expired" | "done";
}

export interface Observation {
  id: string;
  text: string;
  refs: string[];
}

export interface Hypothesis {
  id: string;
  text: string;
  status: "supported" | "rejected" | "inconclusive";
  refs: string[];
}

export interface Investigation {
  schema: string;
  run: string;
  status: "not_needed" | "completed" | "inconclusive" | "failed";
  plan?: { evals?: string[]; extra_metrics?: string[]; reasoning?: string };
  observations: Observation[];
  hypotheses: Hypothesis[];
  proposals: Proposal[];
  diagnosis?: { text: string; confidence?: "low" | "medium" | "high" };
  fix_context?: Record<string, unknown>;
}

export interface Report {
  schema: string;
  run: string;
  verdict: Verdict;
  summary: string[];
  flagged: string[];
  investigation?: Investigation;
  pr_comment_md: string;
}

// ---- API response shapes (UI-side; not yet in types.py — see api.ts) ----

export type RunStatus =
  | "queued"
  | "provisioning"
  | "ready"
  | "measuring"
  | "verdict"
  | "investigating"
  | "done";

export interface RepoInfo {
  name: string; // owner/repo
  gpu: string;
  image: string;
  default_branch: string;
  runs_count: number;
  description?: string;
  evals: string[];
  correctness?: string; // inferval.yaml correctness rule, e.g. token_ids_match
  overrides?: string[]; // inferval.yaml allowed overrides
  last_run: { run: string; verdict: VerdictKind; status: string; t: string } | null;
}

export interface RunSummary {
  run: string;
  mode: Mode;
  branch?: string;
  base_sha: string;
  head_sha?: string;
  verdict: VerdictKind | null; // null while in flight
  status: string;
  flagged: boolean;
  tokens_per_s_delta_pct: number | null;
  p95_delta_pct: number | null;
  vram_delta_pct: number | null;
  duration_s: number | null;
  cost_usd: number | null;
  created_at: string;
  claim?: string;
}

export interface RunDetail {
  spec: RunSpec;
  verdict: Verdict | null;
  status: RunStatus;
  cost_usd: number | null;
}

export interface NewRunRequest {
  repo: string;
  mode: Mode;
  base: string; // a ref: branch name or SHA
  head?: string; // a ref: branch name or SHA
  evals: string[] | null; // null = Auto (agent plans from the diff)
  approvals?: "auto" | "manual";
  claim?: string;
}

// ---- sessions + sandboxes (v3 endpoints; shapes mirror inferval/api) ----

export interface SessionSummary {
  session: string;
  pr: { number: number; title: string; url: string } | null;
  branch: string | null;
  created_at: string;
  status: string;
}

export interface SessionDetail {
  session: string;
  repo: string;
  pr: {
    number: number;
    title: string;
    url: string;
    body: string;
    head: string;
    base: string;
  } | null;
  branch: string | null;
  triage: Annotation[] | null;
  drafts: EvalDraft[];
  status: string;
}

export interface Annotation {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  risk: "perf" | "correctness" | "memory" | "none";
  note: string;
  coverage: string[] | "gap";
}

export interface EvalDraft {
  id: string;
  origin: string;
  name: string;
  cmd: string;
  checks: Record<string, string>;
  est_gpu_seconds: number;
  status: string;
}

export interface SandboxInfo {
  id: string;
  gpu: string | null;
  state: "running" | "cooldown" | "terminated";
  created_at: string | null;
  deadline: number | null; // epoch seconds
  attached: { run?: string; session?: string } | null;
  uptime_s: number | null;
}

export interface Telemetry {
  interval_s: number;
  util_gpu: number[];
  mem_mb: number[];
  power_w: number[];
}

// ---- branches endpoint (GET /api/repos/{name}/branches?base=<ref>) ----

export interface BranchPR {
  number: number;
  title: string;
  url: string;
  claim?: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
  pr: BranchPR | null;
  source?: "github" | "stored";
  state: "verified" | "regression" | "running" | "unverified";
  last_review: {
    run: string;
    verdict: VerdictKind | null;
    tokens_per_s_delta_pct: number | null;
    status: string;
    t: string;
  } | null;
  reviews_count: number;
}

// ---- GitHub connection (single-user OAuth; token stays server-side) ----

export interface GithubStatus {
  connected: boolean;
  login: string | null;
}

export interface GithubRepo {
  name: string; // owner/repo
  private: boolean;
  default_branch: string | null;
  pushed_at: string | null;
}
