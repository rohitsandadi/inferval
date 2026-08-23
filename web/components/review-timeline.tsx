"use client";

// Vertical review history for one branch (wireframe screen 4): rail of dots
// colored by verdict state, newest first; review rows link to the review.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { StatusDot, verdictDot, type DotState } from "@/components/status-dot";
import { fmtCost, fmtDelta, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RunSummary } from "@/lib/types";

export interface TimelineItem {
  kind: "review" | "pr_opened";
  run?: RunSummary;
  t: string;
  note?: string;
}

const ringColor: Record<DotState, string> = {
  ok: "border-ok",
  bad: "border-bad",
  busy: "border-live",
  idle: "border-faint",
};

export function ReviewTimeline({ items }: { items: TimelineItem[] }) {
  const pathname = usePathname();
  const repoBase = pathname.split("/").slice(0, 4).join("/"); // /repo/{owner}/{name}

  return (
    <div className="mt-4 flex flex-col">
      {items.map((item, i) => {
        const dot =
          item.kind === "review" && item.run
            ? verdictDot(item.run.verdict, item.run.status)
            : null;
        const state: DotState = dot?.state ?? "idle";
        const run = item.run;
        const delta = run?.tokens_per_s_delta_pct;
        return (
          <div key={i} className="flex gap-3">
            <div className="flex w-3.5 shrink-0 flex-col items-center">
              <span
                className={cn(
                  "mt-1 size-[9px] shrink-0 rounded-full border-2 bg-background",
                  ringColor[state],
                )}
                aria-hidden
              />
              {i < items.length - 1 && (
                <span className="w-px flex-1 bg-border-soft" aria-hidden />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-5">
              {item.kind === "review" && run && dot ? (
                <>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                    <Link
                      href={`${repoBase}/reviews/${run.run}`}
                      className="font-mono text-foreground hover:underline"
                    >
                      {run.run}
                    </Link>
                    <StatusDot state={dot.state} label={dot.label} />
                    {delta !== null && delta !== undefined && (
                      <span
                        className={cn(
                          "font-mono tabular-nums",
                          run.verdict === "regression" && "text-bad",
                          run.verdict === "pass" && "text-ok",
                        )}
                      >
                        {fmtDelta(delta)} tokens/s
                      </span>
                    )}
                    {run.cost_usd !== null && run.cost_usd !== undefined && (
                      <span className="font-mono text-[11px] text-faint">
                        {fmtCost(run.cost_usd)}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-faint">
                    {fmtRelative(item.t)}
                    {item.note ? ` · ${item.note}` : ""}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                    <span className="text-muted-foreground">{item.note}</span>
                  </div>
                  {item.t && (
                    <p className="mt-0.5 text-[11px] text-faint">
                      {fmtRelative(item.t)}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
      {items.length === 0 && (
        <p className="text-xs text-faint">no reviews yet</p>
      )}
    </div>
  );
}
