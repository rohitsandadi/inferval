// Verdict checks (wireframe screen 8): Eval / Metric / Base / Candidate / Δ /
// Threshold. Red ink only on violated deltas; correctness closes the table.

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusDot } from "@/components/status-dot";
import { Delta, type DeltaTone } from "@/components/atoms";
import { fmtNum, metricLabel } from "@/lib/format";
import type { Verdict } from "@/lib/types";

function tone(violated: boolean, flagged?: boolean): DeltaTone {
  if (violated) return "bad";
  if (flagged) return "warn";
  return "neutral";
}

export function ChecksTable({ verdict }: { verdict: Verdict }) {
  const corr = verdict.correctness?.result ?? "n/a";
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border-soft hover:bg-transparent">
          <TableHead className="text-[11px] font-normal text-faint">Eval</TableHead>
          <TableHead className="text-[11px] font-normal text-faint">Metric</TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint">
            Base
          </TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint">
            Candidate
          </TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint">Δ</TableHead>
          <TableHead className="text-right text-[11px] font-normal text-faint">
            Threshold
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {verdict.checks.map((c, i) => (
          <TableRow
            key={`${c.eval}-${c.metric}-${i}`}
            className="border-border-soft hover:bg-transparent"
          >
            <TableCell className="font-mono text-xs">{c.eval}</TableCell>
            <TableCell className="text-xs">{metricLabel(c.metric)}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">
              {fmtNum(c.base)}
            </TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">
              {fmtNum(c.cand)}
            </TableCell>
            <TableCell className="text-right text-xs">
              <Delta pct={c.delta_pct} tone={tone(c.violated, c.flagged)} />
            </TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums text-faint">
              {c.threshold}
            </TableCell>
          </TableRow>
        ))}
        <TableRow className="border-border-soft hover:bg-transparent">
          <TableCell className="text-xs">all</TableCell>
          <TableCell className="text-xs">correctness</TableCell>
          <TableCell colSpan={3} className="text-right text-xs text-faint">
            token ids{" "}
            {corr === "match"
              ? "match exactly"
              : corr === "mismatch"
                ? "diverge"
                : "not compared"}
          </TableCell>
          <TableCell className="text-right text-xs">
            {corr === "match" ? (
              <StatusDot state="ok" label="Match" />
            ) : corr === "mismatch" ? (
              <StatusDot state="bad" label="Mismatch" />
            ) : (
              <StatusDot state="idle" label="n/a" />
            )}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
