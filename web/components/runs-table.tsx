"use client";

// Review rows (wireframe screen 7): id, change, verdict dot, deltas, cost,
// status dot (blue while live), relative time.

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
import { fmtCost, fmtRelative, shortSha } from "@/lib/format";
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

export function RunsTable({
  repoName,
  runs,
  baseLabel,
}: {
  repoName: string;
  runs: RunSummary[];
  baseLabel?: string;
}) {
  const router = useRouter();
  const [owner, name] = repoName.split("/");
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border-soft hover:bg-transparent">
          <TableHead className="text-[11px] font-normal text-faint">Review</TableHead>
          <TableHead className="text-[11px] font-normal text-faint">Change</TableHead>
          <TableHead className="text-[11px] font-normal text-faint">Verdict</TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint">
            tokens/s Δ
          </TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint">
            p95 Δ
          </TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint">
            Cost
          </TableHead>
          <TableHead className="text-[11px] font-normal text-faint">Status</TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => {
          const live = r.status !== "done";
          const head = r.branch ?? shortSha(r.head_sha);
          const base = baseLabel ?? shortSha(r.base_sha);
          return (
            <TableRow
              key={r.run}
              onClick={() =>
                router.push(`/repo/${owner}/${name}/reviews/${r.run}`)
              }
              className="cursor-pointer border-border-soft"
            >
              <TableCell className="max-w-32 truncate font-mono text-xs">
                {r.run}
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {head} → {base}
              </TableCell>
              <TableCell className="text-xs">
                {r.verdict === null ? (
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
                {r.cost_usd === null ? (
                  <span className="text-faint">—</span>
                ) : (
                  fmtCost(r.cost_usd)
                )}
              </TableCell>
              <TableCell className="text-xs">
                <StatusDot
                  state={live ? "busy" : "idle"}
                  label={
                    live
                      ? r.status[0].toUpperCase() + r.status.slice(1)
                      : "Done"
                  }
                />
              </TableCell>
              <TableCell className="text-right font-mono text-[11px] text-faint">
                {fmtRelative(r.created_at)}
              </TableCell>
            </TableRow>
          );
        })}
        {runs.length === 0 && (
          <TableRow className="border-border-soft hover:bg-transparent">
            <TableCell colSpan={8} className="py-6 text-center text-xs text-faint">
              no reviews
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
