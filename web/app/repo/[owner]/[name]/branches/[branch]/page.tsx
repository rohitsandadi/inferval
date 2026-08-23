"use client";

// Branch detail (wireframe screen 4): header facts, the PR claim, and the
// review timeline — claim, red review, fix commit, re-verify — newest on top.

import { use, useEffect, useMemo } from "react";
import { ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, branchStateDot } from "@/components/status-dot";
import { useRepoShell } from "@/components/repo-shell";
import {
  ReviewTimeline,
  type TimelineItem,
} from "@/components/review-timeline";
import { useBranchesQuery, useRunsQuery } from "@/lib/queries";
import { looksLikeSha, shortSha } from "@/lib/format";

export default function BranchDetailPage({
  params,
}: {
  params: Promise<{ owner: string; name: string; branch: string }>;
}) {
  const { owner, name, branch } = use(params);
  const branchName = decodeURIComponent(branch);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const { repo, openNewReview, setTopbarRight } = useRepoShell();
  const { data: branchesData } = useBranchesQuery(repoName);
  const { data: runsData } = useRunsQuery(repoName);
  const branches = branchesData ?? null;
  const runs = runsData ?? null;

  // The page's one primary action lives in the topbar.
  useEffect(() => {
    setTopbarRight(
      <Button size="sm" onClick={() => openNewReview(branchName)}>
        Review this branch
      </Button>,
    );
    return () => setTopbarRight(null);
  }, [setTopbarRight, openNewReview, branchName]);

  const info = branches?.find((b) => b.name === branchName) ?? null;

  const branchRuns = useMemo(
    () =>
      (runs ?? []).filter(
        (r) =>
          r.branch === branchName ||
          r.head_sha === branchName ||
          (info !== null && r.head_sha === info.sha),
      ),
    [runs, branchName, info],
  );

  const items = useMemo<TimelineItem[]>(() => {
    const list: TimelineItem[] = branchRuns
      .slice()
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .map((r) => ({ kind: "review", run: r, t: r.created_at }));
    if (info?.pr) {
      list.push({
        kind: "pr_opened",
        t: "",
        note: `PR #${info.pr.number} opened with claim`,
      });
    }
    return list;
  }, [branchRuns, info]);

  if (branches === null || runs === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-96" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const dot = info ? branchStateDot(info, false) : null;
  const baseSha =
    branchRuns.map((r) => r.base_sha).find(looksLikeSha) ??
    runs.map((r) => r.base_sha).find(looksLikeSha);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-sm">{branchName}</span>
        {info?.pr && (
          <a href={info.pr.url} target="_blank" rel="noreferrer">
            <Badge variant="outline" className="rounded-full font-mono text-[12px] text-live">
              PR #{info.pr.number}
            </Badge>
          </a>
        )}
        {dot && <StatusDot state={dot.state} label={dot.label} className="text-xs" />}
        <span className="font-mono text-[13px] text-faint">
          {info ? shortSha(info.sha) : "—"}
          {repo
            ? ` · vs ${repo.default_branch}${baseSha ? ` @ ${shortSha(baseSha)}` : ""}`
            : ""}
        </span>
      </div>

      {info?.pr?.claim && (
        <blockquote className="mt-3 border-l-2 border-border py-1 pl-3 text-xs italic text-muted-foreground">
          “{info.pr.claim}”
        </blockquote>
      )}

      <section className="rounded-xl border border-border-soft bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-soft pb-4">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <ListChecks className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Reviews for this branch</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Review runs whose head matches <span className="font-mono text-foreground">{branchName}</span>
                {info?.pr ? `, including PR #${info.pr.number}` : ""}.
              </p>
            </div>
          </div>
          <Badge variant="secondary" className="font-mono">
            {branchRuns.length} {branchRuns.length === 1 ? "review" : "reviews"}
          </Badge>
        </div>
        <ReviewTimeline items={items} />
      </section>
    </div>
  );
}
