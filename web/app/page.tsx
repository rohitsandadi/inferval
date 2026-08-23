"use client";

// Home (wireframe-v3 screen 7): repo table + cross-repo recent-reviews feed.
// The card grid is retired — a table scales and says more per cm².

import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConnectRepoDialog } from "@/components/connect-repo-dialog";
import { Brand } from "@/components/brand";
import { StatusDot } from "@/components/status-dot";
import { Delta } from "@/components/atoms";
import {
  getBranches,
  githubLoginUrl,
  isMock,
  listRuns,
} from "@/lib/api";
import {
  queryKeys,
  useGithubStatusQuery,
  useReposQuery,
} from "@/lib/queries";
import {
  fmtCost,
  fmtRelative,
  looksLikeSha,
  shortSha,
} from "@/lib/format";
import type {
  BranchInfo,
  RunSummary,
} from "@/lib/types";

function relShort(iso: string): string {
  const r = fmtRelative(iso);
  return r === "now" ? "now" : r.replace(" ago", "");
}

export default function HomePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: reposData, isPending: reposPending } = useReposQuery();
  const repos = reposData ?? null;
  const [query, setQuery] = useState("");
  const { data: ghData, isPending: ghPending } = useGithubStatusQuery();
  const gh = ghData ?? (ghPending ? null : { connected: false, login: null });
  const [pickerOpen, setPickerOpen] = useState(false);

  const repoList = useMemo(() => reposData ?? [], [reposData]);
  const branchQueries = useQueries({
    queries: repoList.map((repo) => ({
      queryKey: queryKeys.branches(repo.name),
      queryFn: () => getBranches(repo.name),
      staleTime: 30_000,
    })),
  });
  const runQueries = useQueries({
    queries: repoList.map((repo) => ({
      queryKey: queryKeys.runs(repo.name),
      queryFn: () => listRuns(repo.name),
      staleTime: 30_000,
      refetchInterval: (query: { state: { data?: RunSummary[] } }) =>
        query.state.data?.some((run) => run.status !== "done") ? 5_000 : false,
    })),
  });
  const branchesByRepo = useMemo(
    () =>
      Object.fromEntries(
        repoList.map((repo, i) => [
          repo.name,
          branchQueries[i]?.data as BranchInfo[] | undefined,
        ]),
      ),
    [repoList, branchQueries],
  );
  const runsByRepo = useMemo(
    () =>
      Object.fromEntries(
        repoList.map((repo, i) => [
          repo.name,
          (runQueries[i]?.data as RunSummary[] | undefined) ?? [],
        ]),
      ),
    [repoList, runQueries],
  );

  const refreshRepos = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.repos() });

  const visible = useMemo(
    () =>
      repos?.filter((r) =>
        r.name.toLowerCase().includes(query.trim().toLowerCase()),
      ) ?? null,
    [repos, query],
  );

  // cross-repo feed: newest runs first
  const feed = useMemo(() => {
    const all = Object.entries(runsByRepo).flatMap(([repo, runs]) =>
      runs.map((r) => ({ repo, r })),
    );
    all.sort(
      (a, b) =>
        new Date(b.r.created_at).getTime() - new Date(a.r.created_at).getTime(),
    );
    return all.slice(0, 8);
  }, [runsByRepo]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border-soft bg-sidebar px-6 py-3">
        <Brand />
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search repos…"
              className="h-9 w-64 pl-9 text-sm"
            />
          </div>
          {gh?.connected && (
            <StatusDot state="ok" label={gh.login ?? "connected"} />
          )}
          {gh !== null && !gh.connected && !isMock && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const url = githubLoginUrl();
                if (url) window.location.href = url;
              }}
            >
              Connect GitHub
            </Button>
          )}
          <Button size="sm" onClick={() => setPickerOpen(true)}>
            Connect repo
          </Button>
        </div>
      </header>
      <ConnectRepoDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        gh={gh}
        connectedNames={repos?.map((r) => r.name) ?? []}
        onConnected={refreshRepos}
      />
      <main className="mx-auto w-full max-w-[1480px] flex-1 px-8 py-8 max-md:px-4">
        <div className="mb-7">
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime verification, reviews, and evaluation activity across your projects.
          </p>
        </div>
        <div className="space-y-10">
          {visible === null || reposPending ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border-soft hover:bg-transparent">
                  <TableHead className="text-[13px] font-normal text-faint">Repo</TableHead>
                  <TableHead className="text-[13px] font-normal text-faint">GPU</TableHead>
                  <TableHead className="text-[13px] font-normal text-faint">Suite</TableHead>
                  <TableHead className="text-[13px] font-normal text-faint">Changes</TableHead>
                  <TableHead className="text-[13px] font-normal text-faint">State</TableHead>
                  <TableHead className="text-[13px] font-normal text-faint">
                    Last review
                  </TableHead>
                  <TableHead className="text-right text-[13px] font-normal text-faint">
                    Spend
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((repo) => {
                  const branches = branchesByRepo[repo.name];
                  const runs = runsByRepo[repo.name] ?? [];
                  const regressions =
                    branches?.filter((b) => b.state === "regression").length ??
                    0;
                  const running =
                    branches?.filter((b) => b.state === "running").length ?? 0;
                  const allVerified =
                    branches !== undefined &&
                    branches.length > 0 &&
                    branches.every(
                      (b) => b.state === "verified" || b.reviews_count === 0,
                    ) &&
                    branches.some((b) => b.state === "verified");
                  const prCount = branches?.filter((b) => b.pr).length ?? 0;
                  const spend = runs.reduce(
                    (acc, r) => acc + (r.cost_usd ?? 0),
                    0,
                  );
                  const latest = runs[0];
                  const baseSha = runs
                    .map((r) => r.base_sha)
                    .find(looksLikeSha);
                  return (
                    <TableRow
                      key={repo.name}
                      onClick={() => router.push(`/repo/${repo.name}`)}
                      className="cursor-pointer border-border-soft"
                    >
                      <TableCell>
                        <span className="text-xs font-medium">{repo.name}</span>
                        <span className="mt-0.5 block font-mono text-[11px] text-faint">
                          base {repo.default_branch}
                          {baseSha ? ` @ ${shortSha(baseSha)}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {repo.gpu}
                      </TableCell>
                      <TableCell className="text-xs">
                        {repo.evals.length}{" "}
                        {repo.evals.length === 1 ? "eval" : "evals"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {branches === undefined ? (
                          <span className="text-faint">—</span>
                        ) : branches.length === 0 ? (
                          <span className="text-faint">—</span>
                        ) : (
                          `${branches.length} br${prCount > 0 ? ` · ${prCount} PR${prCount === 1 ? "" : "s"}` : ""}`
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {regressions > 0 ? (
                          <StatusDot
                            state="bad"
                            label={`${regressions} regression${regressions === 1 ? "" : "s"}`}
                          />
                        ) : running > 0 ? (
                          <StatusDot
                            state="busy"
                            label={`${running} running`}
                          />
                        ) : allVerified ? (
                          <StatusDot state="ok" label="All verified" />
                        ) : (
                          <StatusDot state="idle" label="No reviews yet" />
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {latest ? (
                          <span className="flex items-baseline gap-1.5">
                            <Delta
                              pct={latest.tokens_per_s_delta_pct}
                              tone={
                                (latest.tokens_per_s_delta_pct ?? 0) < -3
                                  ? "bad"
                                  : (latest.tokens_per_s_delta_pct ?? 0) > 3
                                    ? "good"
                                    : "neutral"
                              }
                              className="text-xs"
                            />
                            <span className="font-mono text-[12px] text-faint">
                              {relShort(latest.created_at)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {fmtCost(spend)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {visible.length === 0 && (
                  <TableRow className="border-border-soft hover:bg-transparent">
                    <TableCell
                      colSpan={7}
                      className="py-6 text-center text-xs text-faint"
                    >
                      no repos
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}

          <section>
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Recent reviews</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  The latest verification activity across connected repositories.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-4 max-xl:grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
              {feed.map(({ repo, r }) => {
                const live = r.status !== "done";
                return (
                  <Link
                    key={r.run}
                    href={`/repo/${repo}/reviews/${r.run}`}
                    className="group flex min-h-40 flex-col rounded-xl border border-border-soft bg-card p-5 transition-colors hover:border-border hover:bg-muted"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-2 text-xs font-medium">
                        <i
                          className={
                            "size-2 shrink-0 rounded-full " +
                            (live
                              ? "bg-live"
                              : r.verdict === "pass"
                                ? "bg-ok"
                                : "bg-bad")
                          }
                          aria-hidden
                        />
                        {live ? r.status : r.verdict}
                      </span>
                      <span className="font-mono text-[11px] text-faint">
                        {relShort(r.created_at)}
                      </span>
                    </div>
                    <div className="mt-5 min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {repo}
                      </p>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {r.branch ?? "default branch"}
                      </p>
                    </div>
                    <div className="mt-auto flex items-end justify-between gap-3 pt-5">
                      <span className="font-mono text-[11px] text-faint">{r.run}</span>
                      {live ? (
                        <span className="text-xs text-live">in progress</span>
                      ) : (
                        <Delta
                          pct={r.tokens_per_s_delta_pct}
                          tone={
                            (r.tokens_per_s_delta_pct ?? 0) < -3
                              ? "bad"
                              : (r.tokens_per_s_delta_pct ?? 0) > 3
                                ? "good"
                                : "neutral"
                          }
                          className="text-sm font-semibold"
                        />
                      )}
                    </div>
                  </Link>
                );
              })}
              {feed.length === 0 && (
                <div className="col-span-full rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  No reviews yet
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
