"use client";

// Home (wireframe-v3 screen 7): repo table + cross-repo recent-reviews feed.
// The card grid is retired — a table scales and says more per cm².

import { useEffect, useMemo, useState } from "react";
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
import { StatusDot } from "@/components/status-dot";
import { Delta } from "@/components/atoms";
import { getBranches, listRepos, listRuns } from "@/lib/api";
import {
  fmtCost,
  fmtRelative,
  looksLikeSha,
  shortSha,
} from "@/lib/format";
import type { BranchInfo, RepoInfo, RunSummary } from "@/lib/types";

function relShort(iso: string): string {
  const r = fmtRelative(iso);
  return r === "now" ? "now" : r.replace(" ago", "");
}

export default function HomePage() {
  const router = useRouter();
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [branchesByRepo, setBranchesByRepo] = useState<
    Record<string, BranchInfo[]>
  >({});
  const [runsByRepo, setRunsByRepo] = useState<Record<string, RunSummary[]>>(
    {},
  );
  const [query, setQuery] = useState("");

  useEffect(() => {
    listRepos().then((rs) => {
      setRepos(rs);
      rs.forEach((r) => {
        getBranches(r.name).then((bs) =>
          setBranchesByRepo((prev) => ({ ...prev, [r.name]: bs })),
        );
        listRuns(r.name)
          .then((runs) =>
            setRunsByRepo((prev) => ({ ...prev, [r.name]: runs })),
          )
          .catch(() => {});
      });
    });
  }, []);

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
      <header className="flex items-center justify-between gap-3 border-b border-border-soft px-4 py-2">
        <span className="text-[13px] font-semibold">Atlas</span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search repos…"
              className="h-8 w-52 pl-8 text-[13px]"
            />
          </div>
          <Button size="sm">Connect repo</Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1240px] flex-1 p-5">
        <div className="grid grid-cols-[1fr_300px] items-start gap-4 max-md:grid-cols-1">
          {visible === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border-soft hover:bg-transparent">
                  <TableHead className="text-[11px] font-normal text-faint">Repo</TableHead>
                  <TableHead className="text-[11px] font-normal text-faint">GPU</TableHead>
                  <TableHead className="text-[11px] font-normal text-faint">Suite</TableHead>
                  <TableHead className="text-[11px] font-normal text-faint">Changes</TableHead>
                  <TableHead className="text-[11px] font-normal text-faint">State</TableHead>
                  <TableHead className="text-[11px] font-normal text-faint">
                    Last review
                  </TableHead>
                  <TableHead className="text-right text-[11px] font-normal text-faint">
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
                        <span className="mt-0.5 block font-mono text-[9.5px] text-faint">
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
                            <span className="font-mono text-[10px] text-faint">
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

          <div className="border-l border-border-soft pl-3.5 max-md:border-l-0 max-md:pl-0">
            <p className="text-[10.5px] uppercase tracking-wide text-faint">
              Recent reviews
            </p>
            <div className="mt-1">
              {feed.map(({ repo, r }) => {
                const live = r.status !== "done";
                return (
                  <Link
                    key={r.run}
                    href={`/repo/${repo}/reviews/${r.run}`}
                    className="flex items-baseline gap-2 border-b border-border-soft py-1.5 text-[11px] last:border-b-0 hover:bg-surface"
                  >
                    <span className="w-8 shrink-0 font-mono text-[9.5px] text-faint">
                      {relShort(r.created_at)}
                    </span>
                    <i
                      className={
                        "size-[7px] shrink-0 translate-y-px rounded-full " +
                        (live
                          ? "bg-live"
                          : r.verdict === "pass"
                            ? "bg-ok"
                            : "bg-bad")
                      }
                      aria-hidden
                    />
                    <span className="min-w-0 truncate text-muted-foreground">
                      <span className="font-mono text-[10px]">{r.run}</span>
                      {r.branch ? ` ${r.branch}` : ""}{" "}
                      {live ? (
                        <span className="text-faint">— {r.status}</span>
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
                          className="text-[10px]"
                        />
                      )}
                    </span>
                  </Link>
                );
              })}
              {feed.length === 0 && (
                <p className="py-2 text-[11px] text-faint">no reviews yet</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
