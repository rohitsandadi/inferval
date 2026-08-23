"use client";

// The PR/session page (wireframe-v3 screens 1–3, the hero): annotated diff on
// the left, the repo agent's session on the right, one shared context. The
// chain annotation → coverage → gap → eval draft → evidence is the
// load-bearing structure; after a review, verdict chips land back on the
// annotated lines.

import { use, useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/status-dot";
import {
  CoverageChip,
  DiffView,
  RiskTag,
  type VerdictChip,
} from "@/components/diff-view";
import { SessionPane } from "@/components/session-pane";
import { useRepoShell } from "@/components/repo-shell";
import { fetchPrDiffFromGitHub, getRun } from "@/lib/api";
import {
  queryKeys,
  useReportQuery,
  useReviewSessionMutation,
  useSessionDiffQuery,
  useSessionEventsQuery,
  useSessionQuery,
} from "@/lib/queries";
import { parseUnifiedDiff, type DiffFile } from "@/lib/diff";
import { fmtCost, fmtDelta, metricLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Annotation,
  EvalDraft,
  Report,
  VerdictKind,
} from "@/lib/types";

interface LinkedRun {
  verdict: VerdictKind | null;
  status: string;
  cost_usd: number | null;
}

// ---- lifecycle chain -------------------------------------------------------

interface Stage {
  label: string;
  state: "done" | "current" | "future" | "bad";
}

function lifecycle(
  triaged: boolean,
  planned: boolean,
  verdict: VerdictKind | null,
  diagnosed: boolean,
): Stage[] {
  const verified = verdict !== null;
  const bad = verdict === "regression" || verdict === "invalid";
  const stages: Stage[] = [
    { label: "Attached ✓", state: "done" },
    { label: triaged ? "Triaged ✓" : "Triaged", state: triaged ? "done" : "current" },
    {
      label: planned ? "Planned ✓" : "Planned",
      state: planned ? "done" : triaged ? "current" : "future",
    },
    {
      label: verified ? (bad ? "Verified — regression" : "Verified ✓") : "Verified",
      state: verified ? (bad ? "bad" : "done") : planned ? "current" : "future",
    },
    {
      label: "Diagnosed",
      state: diagnosed ? "done" : verified && bad ? "current" : "future",
    },
    { label: "Fixed", state: "future" },
    { label: "Reported", state: "future" },
  ];
  return stages;
}

function StageBadge({ stage }: { stage: Stage }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full font-mono text-[12px]",
        stage.state === "done" && "text-muted-foreground",
        stage.state === "current" && "border-live/45 bg-live/10 text-live",
        stage.state === "bad" && "border-bad/40 text-bad",
        stage.state === "future" && "border-border-soft text-faint",
      )}
    >
      {stage.label}
    </Badge>
  );
}

// ---- page ------------------------------------------------------------------

export default function SessionPage({
  params,
}: {
  params: Promise<{ owner: string; name: string; id: string }>;
}) {
  const { owner, name, id } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const { repo, setCrumbs, setTopbarRight, openNewReview } = useRepoShell();
  const queryClient = useQueryClient();

  const { data: detailData } = useSessionQuery(id);
  const { data: events = [] } = useSessionEventsQuery(id);
  const cachedDiff = useSessionDiffQuery(id);
  const detail = detailData ?? null;
  const githubDiff = useQuery({
    queryKey: [...queryKeys.sessionDiff(id), "github", detail?.pr?.number ?? 0],
    queryFn: () => fetchPrDiffFromGitHub(repoName, detail!.pr!.number),
    enabled: cachedDiff.data === null && Boolean(detail?.pr),
    staleTime: Infinity,
  });
  const diffText = cachedDiff.data ?? githubDiff.data ?? null;
  const diffLoaded =
    !cachedDiff.isPending &&
    !(cachedDiff.data === null && Boolean(detail?.pr) && githubDiff.isPending);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  useEffect(() => {
    if (events.length === 0) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.session(id) });
  }, [events.length, id, queryClient]);

  // review_submitted -> fetch (and, while live, refresh) the linked runs
  const reviewRunIds = useMemo(
    () =>
      events
        .filter((e) => e.kind === "review_submitted")
        .map((e) => String(e.detail.run ?? ""))
        .filter(Boolean),
    [events],
  );
  const linkedRunQueries = useQueries({
    queries: reviewRunIds.map((run) => ({
      queryKey: queryKeys.run(run),
      queryFn: () => getRun(run),
      refetchInterval: (query: { state: { data?: { status?: string } } }) =>
        query.state.data?.status !== "done" ? 5_000 : false,
    })),
  });
  const linkedRuns = useMemo<Record<string, LinkedRun | null>>(
    () =>
      Object.fromEntries(
        reviewRunIds.map((run, index) => {
          const linked = linkedRunQueries[index]?.data;
          return [
            run,
            linked
              ? {
                  verdict: linked.verdict?.verdict ?? null,
                  status: linked.status,
                  cost_usd: linked.cost_usd,
                }
              : null,
          ];
        }),
      ),
    [reviewRunIds, linkedRunQueries],
  );

  // triage: the detail file wins; a live triage event fills in before refetch
  const annotations = useMemo<Annotation[]>(() => {
    if (detail?.triage?.length) return detail.triage;
    const ev = [...events].reverse().find((e) => e.kind === "triage");
    return (ev?.detail.annotations as Annotation[] | undefined) ?? [];
  }, [detail, events]);

  const drafts = useMemo<EvalDraft[]>(() => {
    if (detail?.drafts?.length) return detail.drafts;
    return events
      .filter((e) => e.kind === "eval_draft")
      .map((e) => e.detail as unknown as EvalDraft);
  }, [detail, events]);

  const files = useMemo<DiffFile[]>(
    () => (diffText ? parseUnifiedDiff(diffText) : []),
    [diffText],
  );
  const file =
    files.find((f) => f.path === activeFile) ?? files[0] ?? null;

  // working: an open worker turn — user_message or review_requested with no
  // turn_done/error after it (worker turns carry no user_message)
  const { working, workingSince } = useMemo(() => {
    let lastOpen = -1;
    let lastOpenT: string | null = null;
    let lastClose = -1;
    events.forEach((e, i) => {
      if (e.kind === "user_message" || e.kind === "review_requested") {
        lastOpen = i;
        lastOpenT = e.t;
      } else if (e.kind === "turn_done" || e.kind === "error") lastClose = i;
    });
    return { working: lastOpen > lastClose, workingSince: lastOpenT };
  }, [events]);

  // newest done linked run drives the post-review state
  const doneRun = (() => {
    for (let i = reviewRunIds.length - 1; i >= 0; i--) {
      const r = linkedRuns[reviewRunIds[i]];
      if (r?.verdict) return { run: reviewRunIds[i], ...r };
    }
    return null;
  })();
  const { data: linkedReportData } = useReportQuery(
    doneRun?.run ?? "",
    Boolean(doneRun?.verdict),
  );
  const linkedReport: Report | null = linkedReportData ?? null;

  // verdict chips: map the linked run's checks onto annotations via coverage
  const chips = useMemo<VerdictChip[]>(() => {
    if (!doneRun || !linkedReport || linkedReport.run !== doneRun.run) return [];
    const verdict = linkedReport.verdict;
    const out: VerdictChip[] = [];
    for (const a of annotations) {
      if (a.risk === "correctness") {
        const res = verdict.correctness?.result;
        if (res === "match" || res === "mismatch") {
          out.push({
            path: a.path,
            afterLine: a.end_line,
            tone: res === "match" ? "ok" : "bad",
            text:
              res === "match" ? "token ids match — exact" : "token ids mismatch",
            sub:
              a.coverage !== "gap" && (a.coverage as string[])[0]
                ? (a.coverage as string[])[0]
                : undefined,
          });
        }
        continue;
      }
      if (a.coverage === "gap") continue;
      const evals = a.coverage as string[];
      const mine = verdict.checks.filter(
        (c) => evals.includes(c.eval) && c.delta_pct !== undefined,
      );
      if (mine.length === 0) continue;
      const primary =
        mine.find((c) => c.violated) ??
        mine.find((c) => c.metric === "tokens_per_s") ??
        mine[0];
      const extras = mine
        .filter((c) => c !== primary && c.eval !== primary.eval && c.violated)
        .slice(0, 1)
        .map((c) => `${fmtDelta(c.delta_pct)} ${c.eval}`)
        .join(" · ");
      out.push({
        path: a.path,
        afterLine: a.end_line,
        tone: primary.violated ? "bad" : "ok",
        text: `${primary.violated ? "Regression" : "Pass"} ${fmtDelta(primary.delta_pct)} ${metricLabel(primary.metric)} · ${primary.eval}`,
        sub: extras || undefined,
      });
    }
    return out;
  }, [doneRun, linkedReport, annotations]);

  // topbar: session id + live dot; crumb: PR #N (or the session id)
  useEffect(() => {
    setCrumbs([
      {
        label: detail?.pr ? `PR #${detail.pr.number}` : id,
        mono: true,
      },
    ]);
    return () => setCrumbs(null);
  }, [setCrumbs, detail?.pr, id]);

  useEffect(() => {
    setTopbarRight(
      <span className="flex items-center gap-2.5">
        <span className="font-mono text-[13px] text-faint">session {id}</span>
        <StatusDot
          state={working ? "busy" : "idle"}
          label={working ? "Active" : "Idle"}
          className="text-xs"
        />
      </span>,
    );
    return () => setTopbarRight(null);
  }, [setTopbarRight, id, working]);

  const reviewMutation = useReviewSessionMutation(id, repoName);

  if (detail === null) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-6 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const pr = detail.pr;
  const triaged = annotations.length > 0;
  const planned = reviewRunIds.length > 0;
  const diagnosed =
    linkedReport?.investigation?.status === "completed" &&
    linkedReport.run === doneRun?.run;
  const stages = lifecycle(triaged, planned, doneRun?.verdict ?? null, !!diagnosed);

  const covered = annotations.filter((a) => a.coverage !== "gap").length;
  const gaps = annotations.filter((a) => a.coverage === "gap").length;
  const corr = annotations.filter((a) => a.risk === "correctness").length;

  const draftByOrigin = new Map(drafts.map((d) => [d.origin, d]));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* PR header band */}
      <div className="flex flex-col gap-1.5 border-b border-border-soft px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[14px] font-semibold">
            {pr?.title ?? detail.branch ?? id}
          </span>
          {pr && (
            <a href={pr.url} target="_blank" rel="noreferrer">
              <Badge
                variant="outline"
                className="rounded-full border-live/45 bg-live/10 font-mono text-[12px] text-live"
              >
                PR #{pr.number}
              </Badge>
            </a>
          )}
          {doneRun && (
            <StatusDot
              state={doneRun.verdict === "pass" ? "ok" : "bad"}
              label={doneRun.verdict === "pass" ? "Pass" : "Regression"}
              className="text-xs"
            />
          )}
          <span className="font-mono text-[12px] text-faint">
            {detail.branch ?? "—"} → {pr?.base ?? repo?.default_branch ?? "—"}
            {pr?.head ? ` · ${pr.head.slice(0, 8)}` : ""}
          </span>
          {doneRun && (
            <span className="ml-auto font-mono text-[12px] text-faint">
              review {doneRun.run}
              {doneRun.cost_usd != null ? ` · ${fmtCost(doneRun.cost_usd)}` : ""}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex flex-wrap items-center gap-1">
            {stages.map((s, i) => (
              <span key={s.label} className="flex items-center gap-1">
                <StageBadge stage={s} />
                {i < stages.length - 1 && (
                  <span className="text-[12px] text-faint">→</span>
                )}
              </span>
            ))}
          </span>
          {pr?.body && (
            <span className="max-w-[46ch] truncate pl-2 text-[13px] italic text-muted-foreground">
              “{pr.body}”
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-border-soft pt-3">
          <div className="mr-auto flex min-w-0 items-center gap-2.5">
            <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <p className="text-xs font-semibold">
                Reviews for {pr ? `PR #${pr.number}` : "this branch"}
              </p>
              <p className="text-[11px] text-faint">
                Review runs submitted from this attached session
              </p>
            </div>
          </div>
          {reviewRunIds.length === 0 ? (
            <span className="rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground">
              No affiliated reviews yet
            </span>
          ) : (
            reviewRunIds.map((run) => {
              const linked = linkedRuns[run];
              const reviewState =
                linked?.status !== "done"
                  ? "busy"
                  : linked.verdict === "pass"
                    ? "ok"
                    : linked?.verdict
                      ? "bad"
                      : "idle";
              const reviewLabel =
                linked?.status !== "done"
                  ? (linked?.status ?? "Loading")
                  : linked.verdict === "pass"
                    ? "Pass"
                    : linked?.verdict === "regression"
                      ? "Regression"
                      : linked?.verdict === "invalid"
                        ? "Invalid"
                        : "Unverified";
              return (
                <Link
                  key={run}
                  href={`/repo/${owner}/${name}/reviews/${run}`}
                  className="inline-flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-1.5 transition-colors hover:bg-muted"
                >
                  <span className="font-mono text-[11px] text-foreground">{run}</span>
                  <StatusDot state={reviewState} label={reviewLabel} className="text-xs" />
                </Link>
              );
            })
          )}
        </div>
      </div>

      {/* three columns: tree · diff · session */}
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="w-[148px] shrink-0 border-r border-border-soft p-2.5 text-[13px] max-md:w-full max-md:border-b max-md:border-r-0">
          <p className="text-[12px] uppercase tracking-wide text-faint">
            {files.length === 0
              ? "no diff"
              : `${files.length} file${files.length === 1 ? "" : "s"} changed`}
          </p>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setActiveFile(f.path)}
                className={cn(
                  "flex items-center justify-between gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-left font-mono text-[12px] text-muted-foreground hover:text-foreground",
                  f.path === (file?.path ?? "") &&
                    "border-border-soft bg-surface text-foreground",
                )}
              >
                <span className="truncate">{f.path.split("/").pop()}</span>
                <span className="shrink-0 text-faint">
                  +{f.adds} −{f.dels}
                </span>
              </button>
            ))}
          </div>
          {triaged && (
            <>
              <p className="mt-4 text-[12px] uppercase tracking-wide text-faint">
                Coverage
              </p>
              <div className="mt-1.5 flex flex-col gap-1 text-[12px] text-muted-foreground">
                <span>
                  {covered} {covered === 1 ? "risk" : "risks"} covered
                </span>
                {gaps > 0 && (
                  <span className="text-note">
                    {gaps} gap{gaps === 1 ? "" : "s"} → draft
                  </span>
                )}
                {corr > 0 && (
                  <span className="text-faint">{corr} correctness</span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-3.5">
          {!diffLoaded ? (
            <Skeleton className="h-48 w-full" />
          ) : file ? (
            <DiffView
              file={file}
              annotations={annotations}
              chips={chips}
            />
          ) : (
            <p className="py-8 text-center text-xs text-faint">
              no diff attached
            </p>
          )}

          {triaged && (
            <div className="mt-3 rounded-lg border border-border-soft p-3">
              <p className="text-[13px] font-medium">Annotation → eval chain</p>
              <div className="mt-1.5 flex flex-col gap-1 text-[12px]">
                {annotations.map((a) => {
                  const d = draftByOrigin.get(a.id);
                  return (
                    <div key={a.id} className="flex flex-wrap items-baseline gap-2">
                      <RiskTag risk={a.risk} />
                      <span className="font-mono text-[12px] text-faint">
                        {a.id} ·{" "}
                        {a.start_line === a.end_line
                          ? a.start_line
                          : `${a.start_line}–${a.end_line}`}
                      </span>
                      <span className="text-muted-foreground">{a.note}</span>
                      {a.coverage === "gap" ? (
                        <>
                          <CoverageChip label="gap" gap />
                          {d && (
                            <>
                              <span className="text-[11px] text-faint">
                                → draft
                              </span>
                              <CoverageChip label={d.name} />
                            </>
                          )}
                        </>
                      ) : (
                        (a.coverage as string[]).map((c) => (
                          <CoverageChip key={c} label={c} />
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {triaged && !doneRun && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border-soft p-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Run plan</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {annotations.map((a) =>
                    a.coverage === "gap" ? (
                      draftByOrigin.get(a.id) ? (
                        <span
                          key={a.id}
                          className="flex items-center gap-1"
                        >
                          <CoverageChip
                            label={draftByOrigin.get(a.id)!.name}
                          />
                          <span className="text-[11px] text-faint">
                            ← {a.id} ·{" "}
                            {draftByOrigin.get(a.id)!.status === "proposed"
                              ? "pending approve"
                              : draftByOrigin.get(a.id)!.status}
                          </span>
                        </span>
                      ) : null
                    ) : (
                      (a.coverage as string[]).map((c) => (
                        <span key={`${a.id}-${c}`} className="flex items-center gap-1">
                          <CoverageChip label={c} />
                          <span className="text-[11px] text-faint">← {a.id}</span>
                        </span>
                      ))
                    ),
                  )}
                </div>
                <p className="mt-1.5 font-mono text-[11px] text-faint">
                  {repo?.gpu ?? "—"} · verdict from inferval.yaml thresholds
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => openNewReview(detail.branch ?? undefined)}
              >
                Start review
              </Button>
            </div>
          )}

          {doneRun && linkedReport?.run === doneRun.run && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border-soft p-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Diagnosis</p>
                <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                  {linkedReport.investigation?.diagnosis?.text ??
                    linkedReport.summary[0] ??
                    "—"}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                nativeButton={false}
                render={
                  <a href={`/repo/${owner}/${name}/reviews/${doneRun.run}`} />
                }
              >
                Open review
              </Button>
            </div>
          )}
        </div>

        <div className="flex w-[330px] shrink-0 flex-col border-l border-border-soft max-md:w-full max-md:border-l-0 max-md:border-t">
          <div className="flex items-center justify-between gap-2 border-b border-border-soft px-3 py-2">
            <span className="text-[13px] font-medium">Session</span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-faint">
                {id}
                {pr ? ` · PR #${pr.number}` : ""}
              </span>
              {(pr || detail.branch) && (
                <Button
                  size="xs"
                  onClick={() => reviewMutation.mutate()}
                  disabled={working || reviewMutation.isPending}
                >
                  {working || reviewMutation.isPending
                    ? "Review running"
                    : pr
                      ? "Review this PR"
                      : "Review this branch"}
                </Button>
              )}
            </span>
          </div>
          <SessionPane
            events={events}
            owner={owner}
            name={name}
            repoName={repoName}
            pr={pr}
            branch={detail.branch}
            linkedRuns={linkedRuns}
            working={working}
            workingSince={workingSince}
            onReview={() => reviewMutation.mutate()}
            reviewPending={reviewMutation.isPending}
          />
        </div>
      </div>

    </div>
  );
}
