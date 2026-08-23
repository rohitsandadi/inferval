"use client";

// Review detail (wireframe screens 8–11): header facts + lifecycle chain,
// then Verdict / Proposals / Trace / Report tabs. Event polling and replay
// are unchanged from the pre-tabs page.

import { use, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { getEvents, getReport, getRun, isMock } from "@/lib/api";
import { fmtCost, shortSha } from "@/lib/format";
import { STATUS_CHIPS, statusFromEvents } from "@/lib/phases";
import { cn } from "@/lib/utils";
import type {
  AtlasEvent,
  Investigation,
  Report,
  RunDetail,
} from "@/lib/types";

const REPLAY_MS = 450;
const GPU_USD_PER_S = 1.1 / 3600; // A10G on-demand ballpark; display only

function deriveProposals(
  events: AtlasEvent[],
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
  const { repo, setCrumbs, setTopbarRight } = useRepoShell();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<AtlasEvent[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [visibleCount, setVisibleCount] = useState<number | null>(null); // null = all
  const [replaying, setReplaying] = useState(false);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // initial load
  useEffect(() => {
    getRun(id).then(setDetail).catch(() => setDetail(null));
    getEvents(id).then(setEvents).catch(() => setEvents([]));
    getReport(id).then(setReport).catch(() => setReport(null));
  }, [id]);

  // live polling: real API mode, run not done -> events?since=N every 2s
  useEffect(() => {
    if (isMock || events.length === 0) return;
    if (statusFromEvents(events) === "done") return;
    const t = setInterval(async () => {
      const fresh = await getEvents(id, events.length);
      if (fresh.length > 0) {
        setEvents((prev) => [...prev, ...fresh]);
        getRun(id).then(setDetail);
        getReport(id).then(setReport).catch(() => {});
      }
    }, 2000);
    return () => clearInterval(t);
  }, [id, events]);

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

  // Crumbs: Atlas / repo / branch / id. Topbar right: cost (or live status).
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-sm">{id}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {headLabel} → {baseLabel}
        </span>
        <StatusDot state={dot.state} label={dot.label} className="text-xs" />
        {isMock && events.length > 0 && (
          <Button
            size="xs"
            variant="outline"
            onClick={startReplay}
            disabled={replaying}
            className="ml-auto"
          >
            {replaying ? "Replaying…" : "Replay as live"}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {STATUS_CHIPS.map((chip, i) => (
          <span key={chip.status} className="flex items-center gap-1">
            <Badge
              variant="outline"
              className={cn(
                "rounded-full font-mono text-[10px]",
                i === currentIdx
                  ? "border-live/45 bg-live/10 text-live"
                  : i < currentIdx
                    ? "text-muted-foreground"
                    : "border-border-soft text-faint",
              )}
            >
              {chip.status}
            </Badge>
            {i < STATUS_CHIPS.length - 1 && (
              <span className="text-[10px] text-faint">→</span>
            )}
          </span>
        ))}
      </div>

      <Tabs defaultValue="verdict">
        <TabsList>
          <TabsTrigger value="verdict">Verdict</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
          <TabsTrigger value="trace">Trace</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
        </TabsList>

        <TabsContent value="verdict" className="pt-2">
          {claim && (
            <blockquote className="border-l-2 border-border py-1 pl-3 text-xs italic text-muted-foreground">
              “{claim}”
              {verdictVisible && verdict?.claim?.verified === false && (
                <span className="not-italic text-bad">
                  {" "}
                  — not true by measurement
                </span>
              )}
            </blockquote>
          )}
          {verdictVisible && verdict ? (
            <div className="mt-2">
              <ChecksTable verdict={verdict} />
            </div>
          ) : (
            <p className="mt-3 text-xs text-faint">verdict pending</p>
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
