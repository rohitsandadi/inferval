"use client";

// The PR/session page (wireframe-v3 screens 1–3, the hero): annotated diff on
// the left, the repo agent's session on the right, one shared context. The
// chain annotation → coverage → gap → eval draft → evidence is the
// load-bearing structure; after a review, verdict chips land back on the
// annotated lines.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { NewEvalDialog, type EvalPrefill } from "@/components/new-eval-dialog";
import { useRepoShell } from "@/components/repo-shell";
import {
  fetchPrDiffFromGitHub,
  getReport,
  getRun,
  getSession,
  getSessionDiff,
  getSessionEvents,
  postSessionMessage,
} from "@/lib/api";
import { parseUnifiedDiff, type DiffFile } from "@/lib/diff";
import { fmtCost, fmtDelta, metricLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Annotation,
  AtlasEvent,
  EvalDraft,
  Report,
  RunDetail,
  SessionDetail,
  VerdictKind,
} from "@/lib/types";

const POLL_MS = 2000;

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
        "rounded-full font-mono text-[10px]",
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

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffLoaded, setDiffLoaded] = useState(false);
  const [events, setEvents] = useState<AtlasEvent[]>([]);
  const [linkedRuns, setLinkedRuns] = useState<Record<string, LinkedRun | null>>(
    {},
  );
  const [linkedReport, setLinkedReport] = useState<Report | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [evalDialog, setEvalDialog] = useState<EvalPrefill | null>(null);
  const eventsRef = useRef<AtlasEvent[]>([]);
  eventsRef.current = events;

  // initial load
  useEffect(() => {
    getSession(id).then(setDetail).catch(() => setDetail(null));
    getSessionEvents(id).then(setEvents).catch(() => setEvents([]));
  }, [id]);

  // diff: session cache first, then the GitHub API (CORS-open) fallback
  useEffect(() => {
    let alive = true;
    (async () => {
      let text = await getSessionDiff(id).catch(() => null);
      if (!text && detail?.pr) {
        text = await fetchPrDiffFromGitHub(repoName, detail.pr.number);
      }
      if (alive) {
        setDiffText(text);
        setDiffLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, repoName, detail?.pr]);

  // event polling with the runs-route cursor semantics (cursor = lines held)
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const since = eventsRef.current.length;
        const fresh = await getSessionEvents(id, since);
        if (fresh.length > 0) {
          setEvents((prev) => [...prev, ...fresh]);
          getSession(id).then(setDetail).catch(() => {}); // triage/drafts may have landed
        }
      } catch {
        // transient poll failure: next tick retries
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [id]);

  // review_submitted -> fetch (and, while live, refresh) the linked runs
  const reviewRunIds = useMemo(
    () =>
      events
        .filter((e) => e.kind === "review_submitted")
        .map((e) => String(e.detail.run ?? ""))
        .filter(Boolean),
    [events],
  );
  useEffect(() => {
    if (reviewRunIds.length === 0) return;
    let alive = true;
    const load = async () => {
      for (const run of reviewRunIds) {
        try {
          const d: RunDetail = await getRun(run);
          if (!alive) return;
          setLinkedRuns((m) => ({
            ...m,
            [run]: {
              verdict: d.verdict?.verdict ?? null,
              status: d.status,
              cost_usd: d.cost_usd,
            },
          }));
          if (d.verdict) {
            getReport(run)
              .then((r) => alive && r && setLinkedReport(r))
              .catch(() => {});
          }
        } catch {
          if (alive) setLinkedRuns((m) => ({ ...m, [run]: null }));
        }
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [reviewRunIds]);

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

  // working: a user_message with no turn_done after it
  const { working, workingSince } = useMemo(() => {
    let lastUser = -1;
    let lastUserT: string | null = null;
    let lastDone = -1;
    events.forEach((e, i) => {
      if (e.kind === "user_message") {
        lastUser = i;
        lastUserT = e.t;
      } else if (e.kind === "turn_done") lastDone = i;
    });
    return { working: lastUser > lastDone, workingSince: lastUserT };
  }, [events]);

  // newest done linked run drives the post-review state
  const doneRun = useMemo(() => {
    for (let i = reviewRunIds.length - 1; i >= 0; i--) {
      const r = linkedRuns[reviewRunIds[i]];
      if (r?.verdict) return { run: reviewRunIds[i], ...r };
    }
    return null;
  }, [reviewRunIds, linkedRuns]);

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
        <span className="font-mono text-[11px] text-faint">session {id}</span>
        <StatusDot
          state={working ? "busy" : "idle"}
          label={working ? "Active" : "Idle"}
          className="text-xs"
        />
      </span>,
    );
    return () => setTopbarRight(null);
  }, [setTopbarRight, id, working]);

  const onSend = useCallback(
    async (text: string) => {
      setSending(true);
      try {
        await postSessionMessage(id, text);
        const fresh = await getSessionEvents(id, eventsRef.current.length);
        if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh]);
      } finally {
        setSending(false);
      }
    },
    [id],
  );

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

  const openDraftDialog = (a: Annotation) => {
    const d = draftByOrigin.get(a.id);
    setEvalDialog({
      name: d?.name,
      cmd: d?.cmd,
      checks: d?.checks,
      est_gpu_seconds: d?.est_gpu_seconds,
      provenance: `Prefilled from gap ${a.id}${pr ? ` · PR #${pr.number}` : ""} · session ${id}`,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* PR header band */}
      <div className="flex flex-col gap-1.5 border-b border-border-soft px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[13px] font-semibold">
            {pr?.title ?? detail.branch ?? id}
          </span>
          {pr && (
            <a href={pr.url} target="_blank" rel="noreferrer">
              <Badge
                variant="outline"
                className="rounded-full border-live/45 bg-live/10 font-mono text-[10px] text-live"
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
          <span className="font-mono text-[10.5px] text-faint">
            {detail.branch ?? "—"} → {pr?.base ?? repo?.default_branch ?? "—"}
            {pr?.head ? ` · ${pr.head.slice(0, 8)}` : ""}
          </span>
          {doneRun && (
            <span className="ml-auto font-mono text-[10.5px] text-faint">
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
                  <span className="text-[10px] text-faint">→</span>
                )}
              </span>
            ))}
          </span>
          {pr?.body && (
            <span className="max-w-[46ch] truncate pl-2 text-[11.5px] italic text-muted-foreground">
              “{pr.body}”
            </span>
          )}
        </div>
      </div>

      {/* three columns: tree · diff · session */}
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="w-[148px] shrink-0 border-r border-border-soft p-2.5 text-[11px] max-md:w-full max-md:border-b max-md:border-r-0">
          <p className="text-[10px] uppercase tracking-wide text-faint">
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
                  "flex items-center justify-between gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-left font-mono text-[10.5px] text-muted-foreground hover:text-foreground",
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
              <p className="mt-4 text-[10px] uppercase tracking-wide text-faint">
                Coverage
              </p>
              <div className="mt-1.5 flex flex-col gap-1 text-[10.5px] text-muted-foreground">
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
              onDraftEval={openDraftDialog}
            />
          ) : (
            <p className="py-8 text-center text-xs text-faint">
              no diff attached
            </p>
          )}

          {triaged && (
            <div className="mt-3 rounded-lg border border-border-soft p-3">
              <p className="text-[11px] font-medium">Annotation → eval chain</p>
              <div className="mt-1.5 flex flex-col gap-1 text-[10.5px]">
                {annotations.map((a) => {
                  const d = draftByOrigin.get(a.id);
                  return (
                    <div key={a.id} className="flex flex-wrap items-baseline gap-2">
                      <RiskTag risk={a.risk} />
                      <span className="font-mono text-[10px] text-faint">
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
                              <span className="text-[9.5px] text-faint">
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
                <p className="text-[11px] font-medium">Run plan</p>
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
                          <span className="text-[9.5px] text-faint">
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
                          <span className="text-[9.5px] text-faint">← {a.id}</span>
                        </span>
                      ))
                    ),
                  )}
                </div>
                <p className="mt-1.5 font-mono text-[9.5px] text-faint">
                  {repo?.gpu ?? "—"} · verdict from atlas.yaml thresholds
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
                <p className="text-[11px] font-medium">Diagnosis</p>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
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
                  // eslint-disable-next-line jsx-a11y/anchor-has-content
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
            <span className="text-[11.5px] font-medium">Session</span>
            <span className="font-mono text-[10px] text-faint">
              {id}
              {pr ? ` · PR #${pr.number}` : ""}
            </span>
          </div>
          <SessionPane
            events={events}
            owner={owner}
            name={name}
            linkedRuns={linkedRuns}
            working={working}
            workingSince={workingSince}
            onSend={onSend}
            sending={sending}
          />
        </div>
      </div>

      {repo && (
        <NewEvalDialog
          repo={repo}
          open={evalDialog !== null}
          onOpenChange={(o) => !o && setEvalDialog(null)}
          onCreate={() => setEvalDialog(null)}
          prefill={evalDialog}
        />
      )}
    </div>
  );
}
