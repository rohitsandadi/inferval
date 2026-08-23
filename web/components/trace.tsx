"use client";

// Trace tab (wireframe-v3 screen 5): phase-duration bars from event
// timestamps, then rows grouped under collapsible lifecycle phases; tier
// badges (system neutral / policy amber / agent blue); evidence refs link to
// the artifact. bench_block_done rows carry a GPU-utilization sparkline when
// the run recorded telemetry (absent on pre-telemetry runs — silent).

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { artifactUrl, blockTelemetryFile } from "@/lib/api";
import { useTelemetryQuery } from "@/lib/queries";
import { groupByPhase } from "@/lib/phases";
import { fmtClock, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InfervalEvent, Telemetry, Tier } from "@/lib/types";

const tierStyles: Record<Tier, string> = {
  system: "border-border text-muted-foreground",
  policy: "border-note/40 text-note",
  agent: "border-live/45 text-live",
  human: "border-note/40 text-note",
};

function TierBadge({ tier }: { tier: Tier }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "w-14 justify-center rounded-[4px] px-1.5 font-mono text-[12px]",
        tierStyles[tier] ?? tierStyles.system,
      )}
    >
      {tier}
    </Badge>
  );
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

// Kind-aware one-line summaries; unknown kinds fall back to compact JSON.
function summarize(e: InfervalEvent): string {
  const d = e.detail;
  switch (e.kind) {
    case "run_created":
      return `${str(d.mode)} · ${str(d.repo)} · ${str(d.base)} → ${str(d.head)} · selection ${str(d.selection)}`;
    case "plan":
      return `evals [${(d.evals as string[] | undefined)?.join(", ") ?? ""}] — ${str(d.reasoning)}`;
    case "status":
      return [str(d.status), str(d.gpu ?? d.gpu_name)].filter(Boolean).join(" · ");
    case "preflight_ok":
      return `import + tiny inference ok — base ${d.base ? "ok" : "failed"}, head ${d.head ? "ok" : "failed"}`;
    case "preflight_failed":
      return `${str(d.revision)} attempt ${str(d.attempt)}: ${str(d.error)}`;
    case "bench_block_done": {
      if (d.profile) return `${str(d.revision)} · ${str(d.eval)} · profile trace captured`;
      const parts = [`${str(d.revision)} · ${str(d.eval)}`];
      if (d.tokens_per_s !== undefined) parts.push(`${str(d.tokens_per_s)} tok/s`);
      if (d.latency_ms_median !== undefined) parts.push(`median ${str(d.latency_ms_median)}ms`);
      if (d.latency_ms_p95 !== undefined) parts.push(`p95 ${str(d.latency_ms_p95)}ms`);
      if (d.peak_vram_mb !== undefined) parts.push(`${str(d.peak_vram_mb)} MB VRAM`);
      return parts.join(" · ");
    }
    case "verdict": {
      const viols = d.violations as string[] | undefined;
      const flagged = d.flagged as string[] | undefined;
      const bits = [String(d.verdict ?? "").toUpperCase()];
      if (viols?.length) bits.push(viols.join("; "));
      else if (d.reason) bits.push(str(d.reason));
      else bits.push("no violations");
      if (flagged?.length) bits.push(`flagged: ${flagged.join("; ")}`);
      if (d.claim_verified !== undefined && d.claim_verified !== null)
        bits.push(`claim ${d.claim_verified ? "verified" : "not verified"}`);
      return bits.join(" — ");
    }
    case "tool_call":
      return `turn ${str(d.turn)} · ${str(d.tool)} — ${str(d.result)}`;
    case "observation":
      return `${str(d.id)}: ${str(d.text)}`;
    case "hypothesis":
      return `${str(d.id)}: ${str(d.text)} [${str(d.status)}]`;
    case "probe_proposed":
      return `${str(d.id)} · ${str(d.kind)} — ${str(d.reason)} (est ${str(d.est_gpu_seconds)}s GPU)`;
    case "proposal_approved":
      return `${str(d.id)} approved by ${str(d.by)}`;
    case "proposal_denied":
      return `${str(d.id)} denied by ${str(d.by)}`;
    case "conclusion":
      return `${str(d.diagnosis)} (${str(d.confidence)} confidence)`;
    case "report_ready":
      return `report rendered → ${str(d.path)}`;
    default:
      return JSON.stringify(d);
  }
}

// ---- telemetry sparklines (per bench block) --------------------------------

const SPARK_MAX = 160; // samples drawn; longer series are stride-sampled

function Sparkline({ tele }: { tele: Telemetry }) {
  const raw = tele.util_gpu;
  const stride = Math.max(1, Math.ceil(raw.length / SPARK_MAX));
  const vals = raw.filter((_, i) => i % stride === 0);
  const bw = 2;
  const gap = 1;
  const h = 26;
  const w = vals.length * (bw + gap) - gap;
  const secs = Math.round(raw.length * tele.interval_s);
  const mean = raw.length
    ? Math.round(raw.reduce((a, b) => a + b, 0) / raw.length)
    : 0;
  const mem = tele.mem_mb.length ? Math.round(Math.max(...tele.mem_mb)) : null;
  return (
    <div className="mb-1 ml-[76px] flex flex-wrap items-center gap-3">
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        fill="rgba(82,168,255,0.5)"
        role="img"
        aria-label="GPU utilization, 1s samples"
        className="block"
      >
        {vals.map((v, i) => {
          const bh = Math.max(1, (h * v) / 100);
          return (
            <rect
              key={i}
              x={i * (bw + gap)}
              y={h - bh}
              width={bw}
              height={bh}
            />
          );
        })}
      </svg>
      <span className="whitespace-nowrap font-mono text-[12px] text-faint">
        {secs}s · util x̄ {mean}%{mem !== null ? ` · ${mem} MB` : ""}
      </span>
    </div>
  );
}

function BlockTelemetry({ event }: { event: InfervalEvent }) {
  const file = blockTelemetryFile(event.detail);
  const { data: tele } = useTelemetryQuery(event.run, file);
  if (!tele || tele.util_gpu.length === 0) return null;
  return <Sparkline tele={tele} />;
}

function SpanRow({ event }: { event: InfervalEvent }) {
  const runId = event.run;
  const isBench = event.kind === "bench_block_done" && !event.detail.profile;
  return (
    <>
      <div className="ml-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-l border-border-soft py-1.5 pl-2.5">
        <span className="w-14 shrink-0 font-mono text-[12px] tabular-nums text-faint">
          {fmtTime(event.t)}
        </span>
        <TierBadge tier={event.tier} />
        <code className="font-mono text-[13px] text-foreground/90">
          {event.kind}
        </code>
        <span className="min-w-0 text-xs text-muted-foreground">
          {summarize(event)}
        </span>
        {event.refs?.map((r) => (
          <a
            key={r}
            href={artifactUrl(runId, r) ?? `#artifact-${encodeURIComponent(r)}`}
            title={`evidence artifact: ${r}`}
            className="font-mono text-[12px] text-live hover:underline"
          >
            {r}
          </a>
        ))}
      </div>
      {isBench && <BlockTelemetry event={event} />}
    </>
  );
}

// ---- phase-duration bars ---------------------------------------------------

interface PhaseBar {
  label: string;
  seconds: number;
}

function phaseBars(events: InfervalEvent[]): PhaseBar[] {
  const groups = groupByPhase(events);
  const bars: PhaseBar[] = [];
  for (let i = 0; i < groups.length; i++) {
    const start = new Date(groups[i].events[0].event.t).getTime();
    const next =
      i + 1 < groups.length
        ? new Date(groups[i + 1].events[0].event.t).getTime()
        : new Date(
            groups[i].events[groups[i].events.length - 1].event.t,
          ).getTime();
    const seconds = Math.max(0, Math.round((next - start) / 1000));
    const prev = bars.find((b) => b.label === groups[i].phase);
    if (prev) prev.seconds += seconds;
    else bars.push({ label: groups[i].phase, seconds });
  }
  return bars;
}

function PhaseDurations({ events }: { events: InfervalEvent[] }) {
  const bars = phaseBars(events);
  const max = Math.max(1, ...bars.map((b) => b.seconds));
  if (bars.length < 2) return null;
  return (
    <div className="mb-3">
      <p className="text-[13px] text-faint">Phase durations</p>
      <div className="mt-1.5 max-w-[560px]">
        {bars.map((b) => (
          <div
            key={b.label}
            className="grid grid-cols-[88px_1fr_56px] items-center gap-2.5 py-0.5"
          >
            <span className="text-[13px] text-muted-foreground">{b.label}</span>
            <span className="min-w-0">
              <span
                className="block h-[7px] min-w-[2px] rounded-[2px] bg-[#3F3F3F]"
                style={{ width: `${Math.max(0.5, (b.seconds / max) * 100)}%` }}
              />
            </span>
            <span className="text-right font-mono text-[12px] tabular-nums text-faint">
              {b.seconds >= 60 ? fmtClock(b.seconds) : `${b.seconds}s`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Trace({ events }: { events: InfervalEvent[] }) {
  const groups = groupByPhase(events);
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousCountRef = useRef(events.length);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const previousCount = previousCountRef.current;
    previousCountRef.current = events.length;
    if (events.length <= previousCount || !following) return;

    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [events.length, following]);

  const jumpToLatest = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setFollowing(true);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative">
      <div
        ref={viewportRef}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          const distanceFromBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
          setFollowing(distanceFromBottom < 56);
        }}
        className="max-h-[min(68vh,760px)] space-y-1 overflow-y-auto scroll-smooth pr-2"
      >
        <PhaseDurations events={events} />
        {groups.map((g, gi) => (
          <Collapsible key={`${g.phase}-${gi}`} defaultOpen>
            <CollapsibleTrigger className="group mt-2 flex w-full items-center gap-2 text-left">
              <span className="text-[13px] text-faint">{g.phase}</span>
              <span className="h-px flex-1 bg-border-soft" />
              <ChevronDown className="size-3 text-faint transition-transform group-data-[panel-open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              {g.events.map(({ index, event }) => (
                <SpanRow key={index} event={event} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ))}
        {events.length === 0 && (
          <p className="text-xs text-faint">no events yet</p>
        )}
      </div>
      {!following && events.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-4 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-popover px-3 text-xs font-medium shadow-lg hover:bg-muted"
        >
          <ArrowDown className="size-3.5" />
          Latest
        </button>
      )}
    </div>
  );
}
