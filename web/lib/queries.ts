"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getBranches,
  getEvents,
  getReport,
  getRun,
  getSession,
  getSessionDiff,
  getSessionEvents,
  getTelemetry,
  githubRepos,
  githubStatus,
  listGapBornEvals,
  listRepos,
  listRuns,
  listSandboxes,
  listSessions,
} from "@/lib/api";
import { statusFromEvents } from "@/lib/phases";
import type { InfervalEvent } from "@/lib/types";

export const queryKeys = {
  all: ["inferval"] as const,
  repos: () => [...queryKeys.all, "repos"] as const,
  branches: (repo: string, base?: string) =>
    [...queryKeys.all, "branches", repo, base ?? "default"] as const,
  runs: (repo: string) => [...queryKeys.all, "runs", repo] as const,
  run: (id: string) => [...queryKeys.all, "run", id] as const,
  events: (id: string) => [...queryKeys.all, "events", id] as const,
  report: (id: string) => [...queryKeys.all, "report", id] as const,
  sessions: (repo: string) => [...queryKeys.all, "sessions", repo] as const,
  session: (id: string) => [...queryKeys.all, "session", id] as const,
  sessionDiff: (id: string) => [...queryKeys.all, "session-diff", id] as const,
  sessionEvents: (id: string) =>
    [...queryKeys.all, "session-events", id] as const,
  sandboxes: (repo: string) => [...queryKeys.all, "sandboxes", repo] as const,
  gapBornEvals: (repo: string) =>
    [...queryKeys.all, "gap-born-evals", repo] as const,
  telemetry: (run: string, block: string) =>
    [...queryKeys.all, "telemetry", run, block] as const,
  githubStatus: () => [...queryKeys.all, "github", "status"] as const,
  githubRepos: () => [...queryKeys.all, "github", "repos"] as const,
};

export function useReposQuery() {
  return useQuery({
    queryKey: queryKeys.repos(),
    queryFn: listRepos,
    staleTime: 60_000,
  });
}

export function useRepoQuery(name: string) {
  return useQuery({
    queryKey: queryKeys.repos(),
    queryFn: listRepos,
    select: (repos) => repos.find((repo) => repo.name === name),
    staleTime: 60_000,
  });
}

export function useBranchesQuery(repo: string, base?: string) {
  return useQuery({
    queryKey: queryKeys.branches(repo, base),
    queryFn: () => getBranches(repo, base),
    enabled: Boolean(repo),
  });
}

export function useRunsQuery(repo: string) {
  return useQuery({
    queryKey: queryKeys.runs(repo),
    queryFn: () => listRuns(repo),
    enabled: Boolean(repo),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status !== "done") ? 5_000 : false,
  });
}

export function useRunQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => getRun(id),
    enabled: enabled && Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.status !== "done" ? 5_000 : false,
  });
}

export function useEventsQuery(id: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.events(id);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const current =
        queryClient.getQueryData<InfervalEvent[]>(queryKey) ?? [];
      const fresh = await getEvents(id, current.length);
      return fresh.length > 0 ? [...current, ...fresh] : current;
    },
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const events = query.state.data;
      return events && statusFromEvents(events) === "done" ? false : 2_000;
    },
  });
}

export function useReportQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.report(id),
    queryFn: () => getReport(id),
    enabled: enabled && Boolean(id),
    retry: false,
    refetchInterval: (query) => (query.state.data ? false : 5_000),
  });
}

export function useSessionsQuery(repo: string) {
  return useQuery({
    queryKey: queryKeys.sessions(repo),
    queryFn: () => listSessions(repo),
    enabled: Boolean(repo),
  });
}

export function useSessionQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.session(id),
    queryFn: () => getSession(id),
    enabled: Boolean(id),
  });
}

export function useSessionDiffQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.sessionDiff(id),
    queryFn: () => getSessionDiff(id),
    enabled: Boolean(id),
    staleTime: Infinity,
  });
}

export function useSessionEventsQuery(id: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.sessionEvents(id);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const current =
        queryClient.getQueryData<InfervalEvent[]>(queryKey) ?? [];
      const fresh = await getSessionEvents(id, current.length);
      return fresh.length > 0 ? [...current, ...fresh] : current;
    },
    enabled: Boolean(id),
    refetchInterval: 2_000,
  });
}

export function useSandboxesQuery(repo: string) {
  return useQuery({
    queryKey: queryKeys.sandboxes(repo),
    queryFn: () => listSandboxes(repo),
    enabled: Boolean(repo),
    refetchInterval: 10_000,
  });
}

export function useGapBornEvalsQuery(repo: string) {
  return useQuery({
    queryKey: queryKeys.gapBornEvals(repo),
    queryFn: () => listGapBornEvals(repo),
    enabled: Boolean(repo),
    staleTime: 5 * 60_000,
  });
}

export function useTelemetryQuery(run: string, block: string) {
  return useQuery({
    queryKey: queryKeys.telemetry(run, block),
    queryFn: () => getTelemetry(run, block),
    enabled: Boolean(run && block),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });
}

export function useGithubStatusQuery() {
  return useQuery({
    queryKey: queryKeys.githubStatus(),
    queryFn: githubStatus,
    staleTime: 5 * 60_000,
  });
}

export function useGithubReposQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.githubRepos(),
    queryFn: githubRepos,
    enabled,
    staleTime: 60_000,
  });
}
