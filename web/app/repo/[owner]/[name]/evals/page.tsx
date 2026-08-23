"use client";

// Evals (wireframe-v3 screen 6): the suite as inferval.yaml defines it — name,
// origin, command, thresholds, and the last
// five reviews' deltas per eval (oldest → newest, latest emphasized).

import { use } from "react";
import { useQueries } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRepoShell } from "@/components/repo-shell";
import { getRun } from "@/lib/api";
import {
  queryKeys,
  useRunsQuery,
} from "@/lib/queries";
import { fmtDelta } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CheckResult, EvalSpec } from "@/lib/types";

const METRIC_SHORT: Record<string, string> = {
  tokens_per_s: "tokens/s",
  latency_ms_p95: "p95",
  latency_ms_median: "median",
  peak_vram_mb: "VRAM",
};

function checkBadge(metric: string, threshold: string): string {
  const short = METRIC_SHORT[metric] ?? metric;
  const op = threshold.startsWith("-") ? "≥" : "≤";
  return `${short} ${op} ${threshold}`;
}

function absoluteBadge(metric: string, limit: string): string {
  const short = METRIC_SHORT[metric] ?? metric;
  const unit = metric.startsWith("latency_ms") ? "ms" : "";
  const m = limit.match(/^(<=?|>=?)\s*(\S+)$/);
  if (!m) return `${short} ${limit}${unit}`;
  return `${short} ${m[1]} ${m[2]}${unit}`;
}

// Coloring past the 3% noise margin; the metric's bad direction depends on
// whether bigger is better (tokens/s) or worse (latency, VRAM).
function deltaTone(
  pct: number,
  metric: string,
): "bad" | "good" | "neutral" {
  const badWhenPos = metric !== "tokens_per_s";
  const bad = badWhenPos ? pct > 3 : pct < -3;
  const good = badWhenPos ? pct < -3 : pct > 3;
  return bad ? "bad" : good ? "good" : "neutral";
}

interface EvalRow extends EvalSpec {
  origin: "seed";
}

interface HistoryPoint {
  pct: number;
  metric: string;
}

const HISTORY_N = 5;

export default function EvalsPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const { repo } = useRepoShell();

  const { data: runs = [] } = useRunsQuery(repoName);
  const done = runs.filter((run) => run.verdict !== null).slice(0, HISTORY_N);
  const detailQueries = useQueries({
    queries: done.map((run) => ({
      queryKey: queryKeys.run(run.run),
      queryFn: () => getRun(run.run),
      staleTime: 5 * 60_000,
    })),
  });
  const details = detailQueries.map((query) => query.data ?? null);
  const evals: EvalSpec[] | null = detailQueries.some((query) => query.isPending)
    ? null
    : (details[0]?.spec.evals ?? []);
  const history: CheckResult[][] = details
    .slice()
    .reverse()
    .map((detail) => detail?.verdict?.checks ?? []);
  const specRows: EvalRow[] = (evals ?? []).map((evalSpec) => ({
    ...evalSpec,
    origin: "seed" as const,
  }));
  const fallbackRows: EvalRow[] =
    specRows.length === 0 && repo
      ? repo.evals.map(
          (evalName) =>
            ({ name: evalName, cmd: "", checks: {}, origin: "seed" }) as EvalRow,
        )
      : [];
  const rows: EvalRow[] = [...specRows, ...fallbackRows];

  // One point per past review: the eval's primary metric (tokens/s when the
  // eval measures it, else its first measured check).
  const historyFor = (evalName: string): (HistoryPoint | null)[] => {
    const points = history.map((checks) => {
      const mine = checks.filter(
        (c) => c.eval === evalName && c.delta_pct !== undefined,
      );
      const primary =
        mine.find((c) => c.metric === "tokens_per_s") ?? mine[0];
      return primary
        ? { pct: primary.delta_pct as number, metric: primary.metric }
        : null;
    });
    // pad on the old side to a fixed 5 columns
    while (points.length < HISTORY_N) points.unshift(null);
    return points;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-[13px] text-faint">
          inferval.yaml @ {repo?.default_branch ?? "—"}
          {repo?.correctness ? ` · correctness: ${repo.correctness}` : ""}
          {repo?.overrides?.length
            ? ` · overrides: ${repo.overrides.join(", ")}`
            : ""}
        </p>
      </div>

      {evals === null ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="border-border-soft hover:bg-transparent">
              <TableHead className="text-[13px] font-normal text-faint">Eval</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Origin</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Command</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Checks</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">
                Last {HISTORY_N} reviews (Δ)
              </TableHead>
              <TableHead className="text-right text-[13px] font-normal text-faint">
                Last
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => {
              const points = historyFor(e.name);
              const latest = [...points].reverse().find((p) => p !== null);
              return (
                <TableRow key={e.name} className="border-border-soft hover:bg-transparent">
                  <TableCell className="font-mono text-xs">{e.name}</TableCell>
                  <TableCell>
                    <span className="text-[13px] text-faint">seed</span>
                  </TableCell>
                  <TableCell className="max-w-56">
                    <span className="block truncate font-mono text-[12px] text-faint">
                      {e.cmd || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1.5">
                      {Object.entries(e.checks).map(([m, t]) => (
                        <Badge
                          key={m}
                          variant="outline"
                          className="rounded-full font-mono text-[12px] text-muted-foreground"
                        >
                          {checkBadge(m, t)}
                        </Badge>
                      ))}
                      {Object.entries(e.absolute ?? {}).map(([m, t]) => (
                        <Badge
                          key={`abs-${m}`}
                          variant="outline"
                          className="rounded-full font-mono text-[12px] text-muted-foreground"
                        >
                          {absoluteBadge(m, t)}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="whitespace-nowrap font-mono text-[12px] tabular-nums text-faint">
                      {points.map((p, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-faint"> · </span>}
                          {p === null ? (
                            "—"
                          ) : (
                            <span
                              className={cn(
                                deltaTone(p.pct, p.metric) === "bad" &&
                                  "text-bad",
                                deltaTone(p.pct, p.metric) === "good" &&
                                  "text-ok",
                                i === points.length - 1 &&
                                  "font-semibold text-[12px]",
                              )}
                            >
                              {p.pct > 0 ? "+" : ""}
                              {p.pct.toFixed(1)}
                            </span>
                          )}
                        </span>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {latest ? (
                      <span
                        className={cn(
                          "font-mono tabular-nums",
                          deltaTone(latest.pct, latest.metric) === "bad" &&
                            "text-bad",
                          deltaTone(latest.pct, latest.metric) === "good" &&
                            "text-ok",
                          deltaTone(latest.pct, latest.metric) === "neutral" &&
                            "text-foreground/80",
                        )}
                      >
                        {fmtDelta(latest.pct)}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow className="border-border-soft hover:bg-transparent">
                <TableCell colSpan={6} className="py-6 text-center text-xs text-faint">
                  no evals
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

    </div>
  );
}
