// The only file that knows the backend. Real mode when NEXT_PUBLIC_ATLAS_API
// is set; otherwise everything is served from web/mocks/ (fixture copies).
//
// Frozen endpoints:
//   GET  /api/repos
//   GET  /api/repos/{name}/runs
//   GET  /api/runs/{id}                      -> {spec, verdict, status, cost_usd}
//   GET  /api/runs/{id}/events?since=N       -> JSONL from line N
//   GET  /api/runs/{id}/report
//   POST /api/runs                           -> {run}
//   POST /api/runs/{id}/proposals/{pid}      body {"decision": "approved"|"denied"}

import type {
  AtlasEvent,
  BranchInfo,
  GithubRepo,
  GithubStatus,
  NewRunRequest,
  RepoInfo,
  Report,
  RunDetail,
  RunSummary,
  SandboxInfo,
  SessionDetail,
  SessionSummary,
  Telemetry,
} from "@/lib/types";

import mockRepos from "@/mocks/repos.json";
import mockRunsNanogpt from "@/mocks/runs_nanogpt.json";
import mockBranchesNanogpt from "@/mocks/branches_nanogpt.json";
import eventsFix01 from "@/mocks/events_r_fix01.json";
import eventsPass from "@/mocks/events_r_pass.json";
import eventsNb from "@/mocks/events_r_nb.json";
import eventsInv from "@/mocks/events_r_inv.json";
import specFix01 from "@/mocks/spec_r_fix01.json";
import specPass from "@/mocks/spec_r_pass.json";
import specNb from "@/mocks/spec_r_nb.json";
import specInv from "@/mocks/spec_r_inv.json";
import verdictFix01 from "@/mocks/verdict_r_fix01.json";
import verdictPass from "@/mocks/verdict_r_pass.json";
import verdictNb from "@/mocks/verdict_r_nb.json";
import verdictInv from "@/mocks/verdict_r_inv.json";
import reportFix01 from "@/mocks/report_r_fix01.json";
import reportPass from "@/mocks/report_r_pass.json";
import reportNb from "@/mocks/report_r_nb.json";
import reportInv from "@/mocks/report_r_inv.json";
import mockSessionsNanogpt from "@/mocks/sessions_nanogpt.json";
import mockSession1 from "@/mocks/session_c_7f3a2b91.json";
import mockSession1Events from "@/mocks/session_events_c_7f3a2b91.json";
import mockSession2 from "@/mocks/session_c_1b0e44d7.json";
import mockSession2Events from "@/mocks/session_events_c_1b0e44d7.json";
import mockSandboxesNanogpt from "@/mocks/sandboxes_nanogpt.json";
import mockDiffPr1 from "@/mocks/diff_pr1.json";
import mockTelemetryFix01 from "@/mocks/telemetry_r_fix01.json";

const API = process.env.NEXT_PUBLIC_ATLAS_API; // e.g. https://...modal.run

export const isMock = !API;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

// ---- mock store ----

type MockRun = {
  events: AtlasEvent[];
  detail: RunDetail;
  report: Report | null;
};

function detail(
  spec: unknown,
  verdict: unknown,
  cost: number | null,
): RunDetail {
  return {
    spec: spec as RunDetail["spec"],
    verdict: verdict as RunDetail["verdict"],
    status: "done",
    cost_usd: cost,
  };
}

// Live mock run: fix-sampling mid-measurement. Reuses the fix01 event stream
// up to (not including) the verdict, re-stamped to its own id and time.
const liveEvents: AtlasEvent[] = (eventsFix01 as AtlasEvent[])
  .slice(0, 8)
  .map((e) => ({
    ...e,
    run: "r_c81d09",
    t: new Date(new Date(e.t).getTime() + 30 * 60_000).toISOString(),
  }));

const mockRuns: Record<string, MockRun> = {
  r_c81d09: {
    events: liveEvents,
    detail: {
      spec: {
        ...(specFix01 as RunDetail["spec"]),
        run: "r_c81d09",
        head_sha: "a41f2e80",
        branch: "fix-sampling",
        claim: undefined,
      },
      verdict: null,
      status: "measuring",
      cost_usd: null,
    },
    report: null,
  },
  r_fix01: {
    events: eventsFix01 as AtlasEvent[],
    detail: detail(specFix01, verdictFix01, 0.14),
    report: reportFix01 as Report,
  },
  r_pass: {
    events: eventsPass as AtlasEvent[],
    detail: detail(specPass, verdictPass, 0.05),
    report: reportPass as Report,
  },
  r_nb: {
    events: eventsNb as AtlasEvent[],
    detail: detail(specNb, verdictNb, 0.05),
    report: reportNb as Report,
  },
  r_inv: {
    events: eventsInv as AtlasEvent[],
    detail: detail(specInv, verdictInv, 0.01),
    report: reportInv as Report,
  },
};

// runs submitted through the mock New Run form, newest first
const mockSubmitted: RunSummary[] = [];
let mockRunSeq = 0;

const mockRunsByRepo: Record<string, RunSummary[]> = {
  "rohitsandadi/nanoGPT": mockRunsNanogpt as RunSummary[],
};

function delay<T>(v: T, ms = 120): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(v), ms));
}

// ---- public API ----

export async function listRepos(): Promise<RepoInfo[]> {
  if (!API) return delay(mockRepos as RepoInfo[]);
  return get("/api/repos");
}

export async function getRepo(name: string): Promise<RepoInfo | undefined> {
  const repos = await listRepos();
  return repos.find((r) => r.name === name);
}

// GET /api/repos/{name}/branches?base=<ref> (base defaults server-side to the
// repo's default_branch). Returns [] instead of throwing: the endpoint may not
// exist yet and every page must degrade to an empty state, never crash.
export async function getBranches(
  repo: string,
  base?: string,
): Promise<BranchInfo[]> {
  if (!API) {
    return delay(
      repo === "rohitsandadi/nanoGPT"
        ? (mockBranchesNanogpt as BranchInfo[])
        : [],
    );
  }
  try {
    const q = base ? `?base=${encodeURIComponent(base)}` : "";
    return await get(`/api/repos/${encodeURIComponent(repo)}/branches${q}`);
  } catch {
    return [];
  }
}

export async function listRuns(repo: string): Promise<RunSummary[]> {
  if (!API) {
    const base = mockRunsByRepo[repo] ?? [];
    return delay(repo === "rohitsandadi/nanoGPT" ? [...mockSubmitted, ...base] : base);
  }
  return get(`/api/repos/${encodeURIComponent(repo)}/runs`);
}

export async function getRun(id: string): Promise<RunDetail> {
  if (!API) {
    const r = mockRuns[id];
    if (!r) throw new Error(`unknown run ${id}`);
    return delay(r.detail);
  }
  return get(`/api/runs/${id}`);
}

// Real mode returns JSONL text from line `since`; mock slices the array.
export async function getEvents(
  id: string,
  since = 0,
): Promise<AtlasEvent[]> {
  if (!API) {
    const r = mockRuns[id];
    if (!r) throw new Error(`unknown run ${id}`);
    return delay(r.events.slice(since));
  }
  const res = await fetch(`${API}/api/runs/${id}/events?since=${since}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GET events -> ${res.status}`);
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AtlasEvent);
}

export async function getReport(id: string): Promise<Report | null> {
  if (!API) return delay(mockRuns[id]?.report ?? null);
  return get(`/api/runs/${id}/report`);
}

export async function submitRun(req: NewRunRequest): Promise<{ run: string }> {
  if (!API) {
    const id = `r_new${++mockRunSeq}`;
    const now = new Date().toISOString();
    mockSubmitted.unshift({
      run: id,
      mode: req.mode,
      branch: req.head,
      base_sha: req.base.slice(0, 8),
      head_sha: req.head?.slice(0, 8),
      verdict: null,
      status: "queued",
      flagged: false,
      tokens_per_s_delta_pct: null,
      p95_delta_pct: null,
      vram_delta_pct: null,
      duration_s: null,
      cost_usd: null,
      created_at: now,
      claim: req.claim,
    });
    // Register the run so its review page renders (queued, no verdict yet).
    mockRuns[id] = {
      events: [
        {
          t: now,
          run: id,
          tier: "system",
          kind: "run_created",
          detail: {
            mode: req.mode,
            repo: req.repo,
            base: req.base,
            head: req.head,
            selection: req.evals === null ? "auto" : "pick",
          },
        },
      ],
      detail: {
        spec: {
          ...(specFix01 as RunDetail["spec"]),
          run: id,
          mode: req.mode,
          base_sha: req.base,
          head_sha: req.head,
          branch: req.head,
          claim: req.claim,
          selection: req.evals === null ? "auto" : "pick",
          approvals: req.approvals ?? "auto",
        },
        verdict: null,
        status: "queued",
        cost_usd: null,
      },
      report: null,
    };
    return delay({ run: id }, 400);
  }
  // Server body shape: base_sha/head_sha accept refs (the runner checks out
  // branch names too); selection derived from evals (null = Auto -> the
  // planner narrows; a list = run exactly those).
  return post("/api/runs", {
    repo: req.repo,
    mode: req.mode,
    base_sha: req.base,
    head_sha: req.head,
    branch: req.head,
    claim: req.claim,
    selection: req.evals === null ? "auto" : "pick",
    evals: req.evals ?? undefined,
    approvals: req.approvals,
  });
}

export async function decideProposal(
  runId: string,
  proposalId: string,
  decision: "approved" | "denied",
): Promise<{ ok: boolean }> {
  if (!API) return delay({ ok: true }, 250); // optimistic; caller updates local state
  return post(`/api/runs/${runId}/proposals/${proposalId}`, { decision });
}

// Evidence link target; null in mock mode (no artifact server to hit).
export function artifactUrl(runId: string, path: string): string | null {
  if (!API) return null;
  return `${API}/api/runs/${runId}/artifact?path=${encodeURIComponent(path)}`;
}

// ---- sessions (v3): the PR page's data ----

type MockSession = {
  detail: SessionDetail;
  events: AtlasEvent[];
  diff: string | null;
};

const mockSessions: Record<string, MockSession> = {
  c_7f3a2b91: {
    detail: mockSession1 as SessionDetail,
    events: mockSession1Events as AtlasEvent[],
    diff: (mockDiffPr1 as { diff: string }).diff,
  },
  c_1b0e44d7: {
    detail: mockSession2 as SessionDetail,
    events: mockSession2Events as AtlasEvent[],
    diff: null,
  },
};

const mockSessionLists: Record<string, SessionSummary[]> = {
  "rohitsandadi/nanoGPT": mockSessionsNanogpt as SessionSummary[],
};

let mockSessionSeq = 0;

export async function listSessions(repo: string): Promise<SessionSummary[]> {
  if (!API) return delay(mockSessionLists[repo] ?? []);
  try {
    return await get(`/api/repos/${encodeURIComponent(repo)}/sessions`);
  } catch {
    return [];
  }
}

export async function createSession(
  repo: string,
  body: { pr?: number; branch?: string },
): Promise<{ session: string }> {
  if (!API) {
    const id = `c_new${++mockSessionSeq}`;
    const now = new Date().toISOString();
    mockSessions[id] = {
      detail: {
        session: id,
        repo,
        pr: null,
        branch: body.branch ?? null,
        triage: null,
        drafts: [],
        status: "created",
      },
      events: [],
      diff: null,
    };
    (mockSessionLists[repo] ??= []).unshift({
      session: id,
      pr: null,
      branch: body.branch ?? null,
      created_at: now,
      status: "created",
    });
    return delay({ session: id }, 300);
  }
  return post(`/api/repos/${encodeURIComponent(repo)}/sessions`, body);
}

export async function getSession(id: string): Promise<SessionDetail> {
  if (!API) {
    const s = mockSessions[id];
    if (!s) throw new Error(`unknown session ${id}`);
    return delay(s.detail);
  }
  return get(`/api/sessions/${id}`);
}

// Unified diff text; null when no diff is attached (404).
export async function getSessionDiff(id: string): Promise<string | null> {
  if (!API) return delay(mockSessions[id]?.diff ?? null);
  const res = await fetch(`${API}/api/sessions/${id}/diff`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET diff -> ${res.status}`);
  return res.text();
}

// Fallback when the server has no cached diff: the GitHub REST API serves
// PR diffs with CORS open, so the real diff still renders client-side.
export async function fetchPrDiffFromGitHub(
  repo: string,
  number: number,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${number}`,
      { headers: { Accept: "application/vnd.github.v3.diff" } },
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// NDJSON from line `since` — exact cursor parity with getEvents.
export async function getSessionEvents(
  id: string,
  since = 0,
): Promise<AtlasEvent[]> {
  if (!API) {
    const s = mockSessions[id];
    if (!s) throw new Error(`unknown session ${id}`);
    return delay(s.events.slice(since));
  }
  const res = await fetch(`${API}/api/sessions/${id}/events?since=${since}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GET session events -> ${res.status}`);
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AtlasEvent);
}

export async function postSessionMessage(
  id: string,
  text: string,
): Promise<{ turn: number }> {
  if (!API) {
    const s = mockSessions[id];
    if (!s) throw new Error(`unknown session ${id}`);
    const turn =
      s.events.filter((e) => e.kind === "user_message").length + 1;
    s.events.push({
      t: new Date().toISOString(),
      run: id,
      tier: "human",
      kind: "user_message",
      detail: { text, turn },
    });
    // No agent behind the mock: close the turn so the indicator settles.
    setTimeout(() => {
      s.events.push({
        t: new Date().toISOString(),
        run: id,
        tier: "system",
        kind: "turn_done",
        detail: { turn, ok: true },
      });
    }, 2500);
    return delay({ turn }, 250);
  }
  return post(`/api/sessions/${id}/messages`, { text });
}

// ---- sandboxes (v3) ----

export async function listSandboxes(repo: string): Promise<SandboxInfo[]> {
  if (!API) {
    if (repo !== "rohitsandadi/nanoGPT") return delay([]);
    const now = Date.now() / 1000;
    // Mock rows carry OFFSETS; rebase onto the wall clock at read time.
    return delay(
      (mockSandboxesNanogpt as SandboxInfo[]).map((r) => ({
        ...r,
        deadline: r.deadline === null ? null : now + r.deadline,
        created_at:
          r.uptime_s === null
            ? null
            : new Date((now - r.uptime_s) * 1000).toISOString(),
      })),
    );
  }
  try {
    return await get(`/api/repos/${encodeURIComponent(repo)}/sandboxes`);
  } catch {
    return [];
  }
}

export async function sandboxAction(
  id: string,
  action: "stop" | "extend",
): Promise<{ ok: boolean }> {
  if (!API) return delay({ ok: true }, 250); // optimistic; caller updates local state
  return post(`/api/sandboxes/${encodeURIComponent(id)}`, { action });
}

// ---- gap-born evals (mock-only today: no server route persists approved
// drafts into atlas.yaml yet; real mode returns []) ----

export interface GapBornEval {
  name: string;
  cmd: string;
  checks: Record<string, string>;
  origin: { pr: number };
}

const mockGapBorn: Record<string, GapBornEval[]> = {
  "rohitsandadi/nanoGPT": [
    {
      name: "sample_step",
      cmd: "bench.py --eval sample_step --tokens 64 --batch 1 --repeats 20",
      checks: { latency_ms_p95: "+15%" },
      origin: { pr: 1 },
    },
  ],
};

export async function listGapBornEvals(repo: string): Promise<GapBornEval[]> {
  if (!API) return delay(mockGapBorn[repo] ?? []);
  return [];
}

// ---- telemetry (v3): per-bench-block GPU samples ----

// bench_block_done detail -> "blocks/b{block}_{revision}_{eval}.telemetry.json"
export function blockTelemetryFile(detail: Record<string, unknown>): string {
  return `b${detail.block}_${detail.revision}_${detail.eval}`;
}

export async function getTelemetry(
  runId: string,
  blockFile: string,
): Promise<Telemetry | null> {
  if (!API) {
    if (runId !== "r_fix01") return delay(null);
    const map = mockTelemetryFix01 as Record<string, Telemetry>;
    return delay(map[blockFile] ?? null);
  }
  try {
    const res = await fetch(
      `${API}/api/runs/${runId}/artifact?path=${encodeURIComponent(
        `blocks/${blockFile}.telemetry.json`,
      )}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null; // pre-telemetry runs: always degrade silently
    return (await res.json()) as Telemetry;
  } catch {
    return null;
  }
}

// ---- GitHub connection ----

export async function githubStatus(): Promise<GithubStatus> {
  if (!API) return { connected: false, login: null };
  try {
    return await get("/api/auth/github/status");
  } catch {
    return { connected: false, login: null };
  }
}

// Full-page redirect: the login route 302s to GitHub and back.
export function githubLoginUrl(): string | null {
  return API ? `${API}/api/auth/github/login` : null;
}

export async function githubRepos(): Promise<GithubRepo[]> {
  return get("/api/github/repos");
}

export async function connectRepo(name: string): Promise<RepoInfo> {
  return post("/api/repos", { name });
}
