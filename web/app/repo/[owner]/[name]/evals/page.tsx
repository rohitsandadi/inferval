"use client";

// Evals (wireframe screen 12): the suite as atlas.yaml defines it — name,
// command, thresholds as badges, and the newest measured result per eval.

import { use, useEffect, useMemo, useState } from "react";
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
import { Delta } from "@/components/atoms";
import { NewEvalDialog } from "@/components/new-eval-dialog";
import { useRepoShell } from "@/components/repo-shell";
import { getRun, listRuns } from "@/lib/api";
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

function lastResultTone(pct: number): "bad" | "good" | "neutral" {
  if (pct < -3) return "bad";
  if (pct > 3) return "good";
  return "neutral";
}

export default function EvalsPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const { repo } = useRepoShell();

  const [evals, setEvals] = useState<EvalSpec[] | null>(null);
  const [lastChecks, setLastChecks] = useState<CheckResult[]>([]);
  const [created, setCreated] = useState<EvalSpec[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  // The suite lives in atlas.yaml; the newest verdict-bearing run carries its
  // resolved spec (and the measured checks).
  useEffect(() => {
    let alive = true;
    (async () => {
      const runs = await listRuns(repoName);
      const withVerdict = runs.find((r) => r.verdict !== null);
      if (!withVerdict) {
        if (alive) setEvals([]);
        return;
      }
      try {
        const detail = await getRun(withVerdict.run);
        if (!alive) return;
        setEvals(detail.spec.evals);
        setLastChecks(detail.verdict?.checks ?? []);
      } catch {
        if (alive) setEvals([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [repoName]);

  const rows = useMemo(() => {
    const specRows = evals ?? [];
    const fallback =
      specRows.length === 0 && repo
        ? repo.evals.map((n) => ({ name: n, cmd: "", checks: {} }) as EvalSpec)
        : [];
    return [...specRows, ...fallback, ...created];
  }, [evals, repo, created]);

  const lastFor = (evalName: string): number | null => {
    const c = lastChecks.find(
      (c) => c.eval === evalName && c.metric === "tokens_per_s",
    );
    return c?.delta_pct ?? null;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] text-faint">
          atlas.yaml @ {repo?.default_branch ?? "—"}
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
              <TableHead className="text-[11px] font-normal text-faint">Eval</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">Command</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">Checks</TableHead>
              <TableHead className="text-right text-[11px] font-normal text-faint">
                Last result
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => {
              const last = lastFor(e.name);
              return (
                <TableRow key={e.name} className="border-border-soft hover:bg-transparent">
                  <TableCell className="font-mono text-xs">{e.name}</TableCell>
                  <TableCell className="max-w-64">
                    <span className="block truncate font-mono text-[10.5px] text-faint">
                      {e.cmd || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1.5">
                      {Object.entries(e.checks).map(([m, t]) => (
                        <Badge
                          key={m}
                          variant="outline"
                          className="rounded-full font-mono text-[10px] text-muted-foreground"
                        >
                          {checkBadge(m, t)}
                        </Badge>
                      ))}
                      {Object.entries(e.absolute ?? {}).map(([m, t]) => (
                        <Badge
                          key={`abs-${m}`}
                          variant="outline"
                          className="rounded-full font-mono text-[10px] text-muted-foreground"
                        >
                          {absoluteBadge(m, t)}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {last === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <Delta pct={last} tone={lastResultTone(last)} />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow className="border-border-soft hover:bg-transparent">
                <TableCell colSpan={4} className="py-6 text-center text-xs text-faint">
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
          onCreate={(spec) => setCreated((cs) => [...cs, spec])}
        />
      )}
    </div>
  );
}
