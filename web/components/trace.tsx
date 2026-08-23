"use client";

// Trace tab (wireframe screen 10): rows grouped under collapsible lifecycle
// phases; tier badges (system neutral / policy amber / agent blue); evidence
// refs link to the artifact.

import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { artifactUrl } from "@/lib/api";
import { groupByPhase } from "@/lib/phases";
import { fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AtlasEvent, Tier } from "@/lib/types";

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
        "w-14 justify-center rounded-[4px] px-1.5 font-mono text-[10px]",
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
function summarize(e: AtlasEvent): string {
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

function SpanRow({ event }: { event: AtlasEvent }) {
  const runId = event.run;
  return (
    <div className="ml-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-l border-border-soft py-1.5 pl-2.5">
      <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-faint">
        {fmtTime(event.t)}
      </span>
      <TierBadge tier={event.tier} />
      <code className="font-mono text-[11px] text-foreground/90">
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
          className="font-mono text-[10.5px] text-live hover:underline"
        >
          {r}
        </a>
      ))}
    </div>
  );
}

export function Trace({ events }: { events: AtlasEvent[] }) {
  const groups = groupByPhase(events);
  return (
    <div className="space-y-1">
      {groups.map((g, gi) => (
        <Collapsible key={`${g.phase}-${gi}`} defaultOpen>
          <CollapsibleTrigger className="group mt-2 flex w-full items-center gap-2 text-left">
            <span className="text-[11px] text-faint">{g.phase}</span>
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
  );
}
