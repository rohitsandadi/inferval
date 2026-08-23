"use client";

// Review rows (wireframe-v3 screen 10): id, change, verdict dot, deltas,
// evals, GPU, wall, cost, relative time. Evals/GPU come from each run's spec
// (fetched by the page; "—" until loaded).

import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusDot, verdictDot } from "@/components/status-dot";
import { Delta } from "@/components/atoms";
import { fmtClock, fmtCost, fmtRelative, shortSha } from "@/lib/format";
import type { RunSummary } from "@/lib/types";

function toneFor(
  pct: number | null,
  badWhen: "neg" | "pos",
): "bad" | "good" | "neutral" {
  if (pct === null) return "neutral";
  const bad = badWhen === "neg" ? pct < -3 : pct > 3; // 3% noise margin
  const good = badWhen === "neg" ? pct > 3 : pct < -3;
  return bad ? "bad" : good ? "good" : "neutral";
}

export interface RunExtras {
  evals: number;
  gpu: string;
}

export function RunsTable({
  repoName,
  runs,
  baseLabel,
  extras = {},
}: {
  repoName: string;
  runs: RunSummary[];
  baseLabel?: string;
  extras?: Record<string, RunExtras>;
}) {
  const router = useRouter();
  const [owner, name] = repoName.split("/");
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border-soft hover:bg-transparent">
          <TableHead className="text-[13px] font-normal text-faint">Review</TableHead>
          <TableHead className="text-[13px] font-normal text-faint">Change</TableHead>
          <TableHead className="text-[13px] font-normal text-faint">Verdict</TableHead>
          <TableHead className="text-right text-[13px] font-normal text-faint">
            tokens/s Δ
          </TableHead>
          <TableHead className="text-right text-[13px] font-normal text-faint">
            p95 Δ
          </TableHead>
          <TableHead className="text-right text-[13px] font-normal text-faint">
            Evals
          </TableHead>
          <TableHead className="text-[13px] font-normal text-faint">GPU</TableHead>
          <TableHead className="text-right text-[13px] font-normal text-faint">
            Wall
          </TableHead>
          <TableHead className="text-right text-[13px] font-normal text-faint">
            Cost
          </TableHead>
          <TableHead className="text-right text-[13px] font-normal text-faint">
            When
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => {
          const live = r.status !== "done";
          const head = r.branch ?? shortSha(r.head_sha);
          const base = baseLabel ?? shortSha(r.base_sha);
          const extra = extras[r.run];
          return (
            <TableRow
              key={r.run}
              onClick={() =>
                router.push(`/repo/${owner}/${name}/reviews/${r.run}`)
              }
              className="cursor-pointer border-border-soft"
            >
              <TableCell className="max-w-36 truncate font-mono text-xs">
                {r.run}
              </TableCell>
              <TableCell className="font-mono text-[13px] text-muted-foreground">
                {head} → {base}
              </TableCell>
              <TableCell className="text-xs">
                {live ? (
                  <StatusDot
                    state="busy"
                    label={r.status[0].toUpperCase() + r.status.slice(1)}
                  />
                ) : r.verdict === null ? (
                  <span className="text-faint">—</span>
                ) : (
                  <StatusDot {...verdictDot(r.verdict)} />
                )}
              </TableCell>
              <TableCell className="text-right text-xs">
                <Delta
                  pct={r.tokens_per_s_delta_pct}
                  tone={toneFor(r.tokens_per_s_delta_pct, "neg")}
                />
              </TableCell>
              <TableCell className="text-right text-xs">
                <Delta pct={r.p95_delta_pct} tone={toneFor(r.p95_delta_pct, "pos")} />
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {extra ? extra.evals : <span className="text-faint">—</span>}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {extra ? extra.gpu : <span className="text-faint">—</span>}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {r.duration_s === null ? (
                  <span className="text-faint">—</span>
                ) : (
                  fmtClock(r.duration_s)
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {r.cost_usd === null ? (
                  <span className="text-faint">—</span>
                ) : (
                  fmtCost(r.cost_usd)
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-[13px] text-faint">
                {fmtRelative(r.created_at).replace(" ago", "")}
              </TableCell>
            </TableRow>
          );
        })}
        {runs.length === 0 && (
          <TableRow className="border-border-soft hover:bg-transparent">
            <TableCell colSpan={10} className="py-6 text-center text-xs text-faint">
              no reviews
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
