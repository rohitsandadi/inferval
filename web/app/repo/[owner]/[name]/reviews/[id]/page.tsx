"use client";

// Review detail (wireframe screens 8–11): header facts + lifecycle chain,
// then Verdict / Proposals / Trace / Report tabs. Event polling and replay
// are unchanged from the pre-tabs page.

import { use, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChecksTable } from "@/components/checks-table";
import { ProposalZone, type ProposalWithTime } from "@/components/proposal-card";
import { ReportSection } from "@/components/report-section";
import { StatusDot, verdictDot } from "@/components/status-dot";
import { Trace } from "@/components/trace";
import { useRepoShell } from "@/components/repo-shell";
import { isMock } from "@/lib/api";
import {
  useEventsQuery,
  useReportQuery,
  useRunQuery,
} from "@/lib/queries";
import { fmtClock, fmtCost, shortSha } from "@/lib/format";
import { STATUS_CHIPS, statusFromEvents } from "@/lib/phases";
import { cn } from "@/lib/utils";
import type {
  InfervalEvent,
  Investigation,
} from "@/lib/types";

const REPLAY_MS = 450;
const GPU_USD_PER_S = 1.1 / 3600; // A10G on-demand ballpark; display only

function deriveProposals(
  events: InfervalEvent[],
  investigation: Investigation | undefined,
  investigationVisible: boolean,
): ProposalWithTime[] {
  const map = new Map<string, ProposalWithTime>();
  for (const e of events) {
    const id = String(e.detail.id ?? "");
    if (e.kind === "probe_proposed") {
      map.set(id, {
        id,
        kind: e.detail.kind as ProposalWithTime["kind"],
        params: (e.detail.params as Record<string, unknown>) ?? {},
        reason: String(e.detail.reason ?? ""),
        est_gpu_seconds: Number(e.detail.est_gpu_seconds ?? 0),
        status: "proposed",
        proposed_t: e.t,
      });
    } else if (e.kind === "proposal_approved" && map.has(id)) {
      map.get(id)!.status = "approved";
    } else if (e.kind === "proposal_denied" && map.has(id)) {
      map.get(id)!.status = "denied";
    }
  }
  if (investigationVisible && investigation) {
    for (const p of investigation.proposals) {
      if (map.has(p.id)) map.get(p.id)!.status = p.status;
      else map.set(p.id, p);
    }
  }
  return [...map.values()];
}

export default function ReviewPage({
  params,
}: {
  params: Promise<{ owner: string; name: string; id: string }>;
}) {
  const { owner, name, id } = use(params);
  const { repo, branches, setCrumbs, setTopbarRight } = useRepoShell();
  const { data: detailData } = useRunQuery(id);
  const { data: eventsData = [] } = useEventsQuery(id);
  const reportReady =
    detailData?.status === "done" ||
    eventsData.some((event) => event.kind === "report_ready");
  const { data: reportData } = useReportQuery(id, reportReady);
  const detail = detailData ?? null;
  const events = eventsData;
  const report = reportData ?? null;
  const [visibleCount, setVisibleCount] = useState<number | null>(null); // null = all
  const [replaying, setReplaying] = useState(false);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // replay: reveal the feed one event at a time, as if live
  const startReplay = () => {
    if (replayTimer.current) clearInterval(replayTimer.current);
    setReplaying(true);
    setVisibleCount(0);
    replayTimer.current = setInterval(() => {
      setVisibleCount((n) => {
        const next = (n ?? 0) + 1;
        if (next >= events.length) {
          if (replayTimer.current) clearInterval(replayTimer.current);
          setReplaying(false);
          return null;
        }
        return next;
      });
    }, REPLAY_MS);
  };
  useEffect(
    () => () => {
      if (replayTimer.current) clearInterval(replayTimer.current);
    },
    [],
  );

  const visible = visibleCount === null ? events : events.slice(0, visibleCount);
  const status = useMemo(() => statusFromEvents(visible), [visible]);
  const verdictVisible =
    detail?.verdict != null && visible.some((e) => e.kind === "verdict");
  const reportVisible =
    report != null && visible.some((e) => e.kind === "report_ready");
  const proposals = useMemo(
    () => deriveProposals(visible, report?.investigation, reportVisible),
    [visible, report, reportVisible],
  );

  const spec = detail?.spec;
  const branch = spec?.branch;
  const headLabel = branch ?? shortSha(spec?.head_sha);
  const baseLabel = repo?.default_branch ?? shortSha(spec?.base_sha);
  const done = status === "done";
  const cost = detail?.cost_usd ?? null;

  // Crumbs: inferval / repo / branch / id. Topbar right: cost (or live status).
  useEffect(() => {
    setCrumbs([
      ...(branch
        ? [
            {
              label: branch,
              href: `/repo/${owner}/${name}/branches/${encodeURIComponent(branch)}`,
              mono: true,
            },
          ]
        : []),
      { label: id, mono: true },
    ]);
    return () => setCrumbs(null);
  }, [setCrumbs, owner, name, id, branch]);

  useEffect(() => {
    setTopbarRight(
      done && cost !== null ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="font-mono text-[11px] text-faint">
                  {fmtCost(cost)}
                </span>
              }
            />
            <TooltipContent>
              {Math.round(cost / GPU_USD_PER_S)} GPU-s
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <StatusDot
          state="busy"
          label={status[0].toUpperCase() + status.slice(1)}
          className="text-xs"
        />
      ),
    );
    return () => setTopbarRight(null);
  }, [setTopbarRight, done, cost, status]);

  if (detail === null) {
    return <p className="text-xs text-faint">loading…</p>;
  }

  const verdict = detail.verdict;
  const claim = verdict?.claim?.text ?? spec?.claim;
  const currentIdx = STATUS_CHIPS.findIndex((c) => c.status === status);
  const dot = verdictDot(verdictVisible ? (verdict?.verdict ?? null) : null, status);
  const prNumber = branch
    ? (branches.find((b) => b.name === branch)?.pr?.number ?? null)
    : null;

  // one band: id · change · verdict · hardware · wall · lifecycle
  const wallS =
    visible.length >= 2
      ? (new Date(visible[visible.length - 1].t).getTime() -
          new Date(visible[0].t).getTime()) /
        1000
      : null;
  const gpuSeconds = cost !== null ? Math.round(cost / GPU_USD_PER_S) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-sm">{id}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {headLabel} → {baseLabel}
        </span>
        <StatusDot state={dot.state} label={dot.label} className="text-xs" />
        <span className="ml-auto flex items-center gap-3">
          <span className="font-mono text-[10.5px] text-faint">
            {spec?.gpu ?? "—"} · {spec?.evals.length ?? "—"}{" "}
            {spec?.evals.length === 1 ? "eval" : "evals"}
            {wallS !== null ? ` · wall ${fmtClock(wallS)}` : ""}
            {gpuSeconds !== null ? ` · ${gpuSeconds} GPU-s` : ""}
            {" · "}
            {STATUS_CHIPS.map((chip, i) => (
              <span key={chip.status}>
                {i > 0 && "→"}
                <span
                  className={cn(
                    i === currentIdx && "font-semibold text-foreground",
                    i > currentIdx && "opacity-50",
                  )}
                >
                  {chip.status}
                </span>
              </span>
            ))}
          </span>
          {isMock && events.length > 0 && (
            <Button
              size="xs"
              variant="outline"
              onClick={startReplay}
              disabled={replaying}
            >
              {replaying ? "Replaying…" : "Replay as live"}
            </Button>
          )}
        </span>
      </div>

      <Tabs defaultValue="verdict">
        <TabsList>
          <TabsTrigger value="verdict">Verdict</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
          <TabsTrigger value="trace">Trace</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
        </TabsList>

        <TabsContent value="verdict" className="pt-2">
          {verdictVisible && verdict ? (
            <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-md:grid-cols-1">
              <ChecksTable verdict={verdict} />
              <div className="space-y-2.5">
                {claim && (
                  <blockquote className="border-l-2 border-border py-1 pl-3 text-xs italic text-muted-foreground">
                    “{claim}”
                    {verdict.claim?.verified === false && (
                      <span className="not-italic text-bad">
                        {" "}
                        — not true by measurement
                      </span>
                    )}
                  </blockquote>
                )}
                {reportVisible &&
                  report?.investigation?.diagnosis?.text && (
                    <div className="rounded-lg border border-border-soft p-3">
                      <p className="flex items-center gap-2 text-[11.5px] font-medium">
                        Diagnosis
                        {report.investigation.diagnosis.confidence && (
                          <Badge
                            variant="outline"
                            className="rounded-full font-mono text-[10px] text-muted-foreground"
                          >
                            {report.investigation.diagnosis.confidence}{" "}
                            confidence
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {report.investigation.diagnosis.text}
                      </p>
                    </div>
                  )}
                {prNumber !== null && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border-soft px-3 py-2">
                    <p className="min-w-0 text-[11px] text-muted-foreground">
                      Results anchored on the diff
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      nativeButton={false}
                      render={
                        <a
                          href={`/repo/${owner}/${name}/prs/${prNumber}`}
                        />
                      }
                    >
                      Open PR #{prNumber}
                    </Button>
                  </div>
                )}
                {reportVisible &&
                  report?.investigation?.fix_context &&
                  Object.keys(report.investigation.fix_context).length > 0 && (
                    <Collapsible>
                      <div className="rounded-lg border border-border-soft px-3 py-2">
                        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left">
                          <span className="font-mono text-[10.5px] text-muted-foreground">
                            fix_context.json — for the coding agent
                          </span>
                          <span className="text-[10px] text-faint">expand</span>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <pre className="mt-2 overflow-x-auto font-mono text-[10px] leading-relaxed text-muted-foreground">
                            {JSON.stringify(
                              report.investigation.fix_context,
                              null,
                              2,
                            )}
                          </pre>
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  )}
              </div>
            </div>
          ) : (
            <>
              {claim && (
                <blockquote className="border-l-2 border-border py-1 pl-3 text-xs italic text-muted-foreground">
                  “{claim}”
                </blockquote>
              )}
              <p className="mt-3 text-xs text-faint">verdict pending</p>
            </>
          )}
        </TabsContent>

        <TabsContent value="proposals" className="pt-3">
          <ProposalZone runId={id} proposals={proposals} />
        </TabsContent>

        <TabsContent value="trace" className="pt-2">
          <Trace events={visible} />
        </TabsContent>

        <TabsContent value="report" className="pt-3">
          {reportVisible && report ? (
            <ReportSection report={report} />
          ) : (
            <p className="text-xs text-faint">report pending</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
