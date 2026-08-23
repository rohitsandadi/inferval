"use client";

// Evals (wireframe-v3 screen 6): the suite as inferval.yaml defines it — name,
// origin, command, thresholds, and the last
// five reviews' deltas per eval (oldest → newest, latest emphasized).

import { use, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { NewEvalDialog } from "@/components/new-eval-dialog";
import { useRepoShell } from "@/components/repo-shell";
import { getRun } from "@/lib/api";
import {
  queryKeys,
  useDeleteEvalMutation,
  useEvalsQuery,
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

// The harness command is plumbing; the table shows the scenario knobs it
// encodes. Commands that don't match the harness shape (a repo's own bench)
// fall back to the raw command.
function scenarioLabel(cmd: string): string | null {
  const pick = (flag: string) =>
    cmd.match(new RegExp(`--${flag}[ =](\\d+)`))?.[1];
  const parts = [
    pick("tokens") && `tokens ${pick("tokens")}`,
    pick("batch") && `batch ${pick("batch")}`,
    pick("repeats") && `repeats ${pick("repeats")}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
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
  origin?: "seed" | "manual" | { pr: number };
  store?: boolean; // from the eval store -> removable
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

  const [dialogOpen, setDialogOpen] = useState(false);

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
  // Store rows overlay everything else by name, mirroring the backend overlay.
  const { data: stored = [] } = useEvalsQuery(repoName);
  const deleteMutation = useDeleteEvalMutation(repoName);
  const storeRows: EvalRow[] = stored.map((item) => {
    const pr = item.origin?.match(/^pr:(\d+)$/);
    return {
      name: item.name,
      cmd: item.cmd,
      checks: item.checks,
      absolute: item.absolute,
      origin: pr ? { pr: Number(pr[1]) } : "manual",
      store: true,
    };
  });
  const storeNames = new Set(storeRows.map((evalSpec) => evalSpec.name));

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
  const rows: EvalRow[] = [...specRows, ...fallbackRows]
    .filter((evalSpec) => !storeNames.has(evalSpec.name))
    .concat(storeRows);

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[13px] text-faint">
          inferval.yaml @ {repo?.default_branch ?? "—"}
          {repo?.correctness ? ` · correctness: ${repo.correctness}` : ""}
          {repo?.overrides?.length
            ? ` · overrides: ${repo.overrides.join(", ")}`
            : ""}
        </p>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          New eval
        </Button>
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
              <TableHead className="text-[13px] font-normal text-faint">Scenario</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Checks</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">
                Last {HISTORY_N} reviews (Δ)
              </TableHead>
              <TableHead className="text-right text-[13px] font-normal text-faint">
                Last
              </TableHead>
              <TableHead className="w-8" />
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
                    {typeof e.origin === "object" && e.origin !== null ? (
                      <Badge
                        variant="outline"
                        className="rounded-full border-live/45 bg-live/10 font-mono text-[12px] text-live"
                      >
                        from PR #{e.origin.pr}
                      </Badge>
                    ) : (
                      <span className="text-[13px] text-faint">
                        {e.origin === "manual" ? "manual" : "seed"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-56">
                    <span className="block truncate font-mono text-[12px] text-faint">
                      {e.cmd ? (scenarioLabel(e.cmd) ?? e.cmd) : "—"}
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
                  <TableCell className="w-8 text-right">
                    {e.store && (
                      <button
                        type="button"
                        aria-label={`Remove ${e.name}`}
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(e.name)}
                        className="text-faint hover:text-foreground disabled:opacity-50"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow className="border-border-soft hover:bg-transparent">
                <TableCell colSpan={7} className="py-6 text-center text-xs text-faint">
                  no evals
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {repo && (
        <NewEvalDialog
          repo={repo}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </div>
  );
}
