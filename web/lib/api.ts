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
  NewRunRequest,
  RepoInfo,
  Report,
  RunDetail,
  RunSummary,
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
