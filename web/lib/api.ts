// The frontend talks only to the configured inferval API. TanStack Query owns
// client-side caching; this module owns endpoint paths and response parsing.

import type {
  BranchInfo,
  GithubRepo,
  GithubStatus,
  InfervalEvent,
  NewRunRequest,
  RepoInfo,
  Report,
  RunDetail,
  RunSummary,
  SandboxInfo,
  SessionDetail,
  SessionSummary,
  StoredEval,
  Telemetry,
} from "@/lib/types";

const DEFAULT_API = "https://atlas-verification--atlas-api.modal.run";
const API = (process.env.NEXT_PUBLIC_INFERVAL_API || DEFAULT_API).replace(
  /\/$/,
  "",
);

// These legacy evals remain available to the backend, but are intentionally
// hidden from every frontend response surface.
const HIDDEN_EVALS = new Set(["generate_short", "generate_long"]);

function isVisibleEval(name: unknown): boolean {
  return typeof name !== "string" || !HIDDEN_EVALS.has(name);
}

function hideEvalsFromEvent(event: InfervalEvent): InfervalEvent | null {
  if (!isVisibleEval(event.detail.eval)) return null;

  const params = event.detail.params;
  if (
    params &&
    typeof params === "object" &&
    "eval" in params &&
    !isVisibleEval((params as Record<string, unknown>).eval)
  ) {
    return null;
  }

  if (!Array.isArray(event.detail.evals)) return event;

  return {
    ...event,
    detail: {
      ...event.detail,
      evals: event.detail.evals.filter(isVisibleEval),
    },
  };
}

function hideEvalsFromEvents(events: InfervalEvent[]): InfervalEvent[] {
  return events.flatMap((event) => {
    const visible = hideEvalsFromEvent(event);
    return visible ? [visible] : [];
  });
}

function hideEvalsFromRun(detail: RunDetail): RunDetail {
  return {
    ...detail,
    spec: {
      ...detail.spec,
      evals: detail.spec.evals.filter((evalSpec) =>
        isVisibleEval(evalSpec.name),
      ),
    },
    verdict: detail.verdict
      ? {
          ...detail.verdict,
          checks: detail.verdict.checks.filter((check) =>
            isVisibleEval(check.eval),
          ),
        }
      : null,
  };
}

function apiUrl(path: string): string {
  return `${API}${path}`;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return response.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status}`);
  return response.json();
}

async function remove<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { method: "DELETE" });
  if (!response.ok) throw new Error(`DELETE ${path} -> ${response.status}`);
  return response.json();
}

export async function listRepos(): Promise<RepoInfo[]> {
  const repos = await get<RepoInfo[]>("/api/repos");
  return repos.map((repo) => ({
    ...repo,
    evals: repo.evals.filter(isVisibleEval),
  }));
}

export async function getRepo(name: string): Promise<RepoInfo | undefined> {
  const repos = await listRepos();
  return repos.find((repo) => repo.name === name);
}

export async function getBranches(
  repo: string,
  base?: string,
): Promise<BranchInfo[]> {
  const query = base ? `?base=${encodeURIComponent(base)}` : "";
  return get(`/api/repos/${encodeURIComponent(repo)}/branches${query}`);
}

export async function listRuns(repo: string): Promise<RunSummary[]> {
  return get(`/api/repos/${encodeURIComponent(repo)}/runs`);
}

export async function getRun(id: string): Promise<RunDetail> {
  const detail = await get<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
  return hideEvalsFromRun(detail);
}

export async function getEvents(
  id: string,
  since = 0,
): Promise<InfervalEvent[]> {
  const response = await fetch(
    apiUrl(`/api/runs/${encodeURIComponent(id)}/events?since=${since}`),
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`GET events -> ${response.status}`);
  const text = await response.text();
  const events = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as InfervalEvent);
  return hideEvalsFromEvents(events);
}

export async function getReport(id: string): Promise<Report | null> {
  const report = await get<Report | null>(
    `/api/runs/${encodeURIComponent(id)}/report`,
  );
  if (!report) return null;

  return {
    ...report,
    verdict: {
      ...report.verdict,
      checks: report.verdict.checks.filter((check) =>
        isVisibleEval(check.eval),
      ),
    },
    investigation: report.investigation
      ? {
          ...report.investigation,
          plan: report.investigation.plan
            ? {
                ...report.investigation.plan,
                evals: report.investigation.plan.evals?.filter(isVisibleEval),
              }
            : undefined,
          proposals: report.investigation.proposals.filter((proposal) =>
            isVisibleEval(proposal.params.eval),
          ),
        }
      : undefined,
  };
}

export async function submitRun(req: NewRunRequest): Promise<{ run: string }> {
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
  return post(
    `/api/runs/${encodeURIComponent(runId)}/proposals/${encodeURIComponent(proposalId)}`,
    { decision },
  );
}

export function artifactUrl(runId: string, path: string): string {
  return `${API}/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
}

export async function listSessions(repo: string): Promise<SessionSummary[]> {
  return get(`/api/repos/${encodeURIComponent(repo)}/sessions`);
}

export async function createSession(
  repo: string,
  body: { pr?: number; branch?: string },
): Promise<{ session: string }> {
  return post(`/api/repos/${encodeURIComponent(repo)}/sessions`, body);
}

export async function getSession(id: string): Promise<SessionDetail> {
  const detail = await get<SessionDetail>(
    `/api/sessions/${encodeURIComponent(id)}`,
  );
  return {
    ...detail,
    triage: detail.triage?.map((annotation) => ({
      ...annotation,
      coverage:
        annotation.coverage === "gap"
          ? "gap"
          : annotation.coverage.filter(isVisibleEval),
    })) ?? null,
    drafts: detail.drafts.filter((draft) => isVisibleEval(draft.name)),
  };
}

export async function getSessionDiff(id: string): Promise<string | null> {
  const response = await fetch(
    apiUrl(`/api/sessions/${encodeURIComponent(id)}/diff`),
    { cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET diff -> ${response.status}`);
  return response.text();
}

export async function fetchPrDiffFromGitHub(
  repo: string,
  number: number,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${number}`,
      { headers: { Accept: "application/vnd.github.v3.diff" } },
    );
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

export async function getSessionEvents(
  id: string,
  since = 0,
): Promise<InfervalEvent[]> {
  const response = await fetch(
    apiUrl(`/api/sessions/${encodeURIComponent(id)}/events?since=${since}`),
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`GET session events -> ${response.status}`);
  }
  const text = await response.text();
  const events = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as InfervalEvent);
  return hideEvalsFromEvents(events);
}

export async function postSessionMessage(
  id: string,
  text: string,
): Promise<{ turn: number }> {
  return post(`/api/sessions/${encodeURIComponent(id)}/messages`, { text });
}

// One background worker turn on an existing session; the artifacts land in the
// session event stream. 422 when the session has no PR/branch attached.
export async function reviewSession(id: string): Promise<{ session: string }> {
  return post(`/api/sessions/${encodeURIComponent(id)}/review`, {});
}

export async function listSandboxes(repo: string): Promise<SandboxInfo[]> {
  return get(`/api/repos/${encodeURIComponent(repo)}/sandboxes`);
}

export async function sandboxAction(
  id: string,
  action: "stop" | "extend",
): Promise<{ ok: boolean }> {
  return post(`/api/sandboxes/${encodeURIComponent(id)}`, { action });
}

// ---- eval store: per-repo stored evals that overlay the seeded suite ----

export async function listEvals(repo: string): Promise<StoredEval[]> {
  return get(`/api/repos/${encodeURIComponent(repo)}/evals`);
}

// 422 -> Error carrying the server's `detail` string, so the UI can show it.
export async function createEval(
  repo: string,
  spec: StoredEval,
): Promise<StoredEval> {
  const res = await fetch(`${API}/api/repos/${encodeURIComponent(repo)}/evals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (typeof b?.detail === "string" ? b.detail : null))
      .catch(() => null);
    throw new Error(detail ?? `POST evals -> ${res.status}`);
  }
  return res.json();
}

export async function deleteEval(
  repo: string,
  name: string,
): Promise<{ deleted: string }> {
  const res = await fetch(
    `${API}/api/repos/${encodeURIComponent(repo)}/evals/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`DELETE eval ${name} -> ${res.status}`);
  return res.json();
}

export function blockTelemetryFile(detail: Record<string, unknown>): string {
  return `b${detail.block}_${detail.revision}_${detail.eval}`;
}

export async function getTelemetry(
  runId: string,
  blockFile: string,
): Promise<Telemetry | null> {
  try {
    const response = await fetch(
      apiUrl(
        `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(
          `blocks/${blockFile}.telemetry.json`,
        )}`,
      ),
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    return (await response.json()) as Telemetry;
  } catch {
    return null;
  }
}

export async function githubStatus(): Promise<GithubStatus> {
  try {
    return await get("/api/auth/github/status");
  } catch {
    return { connected: false, login: null };
  }
}

export function githubLoginUrl(): string {
  return `${API}/api/auth/github/login`;
}

export async function githubRepos(): Promise<GithubRepo[]> {
  return get("/api/github/repos");
}

export async function connectRepo(name: string): Promise<RepoInfo> {
  return post("/api/repos", { name });
}

export async function removeRepo(
  name: string,
): Promise<{ ok: boolean; name: string }> {
  return remove(`/api/repos?name=${encodeURIComponent(name)}`);
}
