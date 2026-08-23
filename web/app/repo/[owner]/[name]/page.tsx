"use client";

// Repo overview (wireframe screen 2): pin line, four stat cards, the changes
// table, and the agent-connect card.

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { StatusDot, branchStateDot } from "@/components/status-dot";
import { agentPrompt } from "@/components/agent-prompt";
import { useRepoShell } from "@/components/repo-shell";
import { listRuns } from "@/lib/api";
import { fmtCost, fmtRelative, looksLikeSha, shortSha } from "@/lib/format";
import type { RunSummary } from "@/lib/types";

export default function OverviewPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const router = useRouter();
  const { repo, branches, runsVersion } = useRepoShell();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  useEffect(() => {
    listRuns(repoName).then(setRuns);
  }, [repoName, runsVersion]);

  const changes = useMemo(
    () => branches.filter((b) => b.reviews_count > 0),
    [branches],
  );
  const prCount = changes.filter((b) => b.pr).length;
  const regressions = branches.filter((b) => b.state === "regression").length;
  const spend = useMemo(
    () => (runs ?? []).reduce((acc, r) => acc + (r.cost_usd ?? 0), 0),
    [runs],
  );
  const baseSha = runs?.map((r) => r.base_sha).find(looksLikeSha);

  if (!repo) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-4 gap-2.5 max-md:grid-cols-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="font-mono text-[11px] text-faint">
        base: {repo.default_branch}
        {baseSha ? ` @ ${shortSha(baseSha)}` : ""} · {repo.image}
      </p>

      <div className="grid grid-cols-4 gap-2.5 max-md:grid-cols-2 max-sm:grid-cols-1">
        <div className="rounded-xl border border-border-soft px-3 py-2.5">
          <p className="text-[11px] text-faint">Open changes</p>
          <p className="mt-1 text-[13px]">
            {changes.length} {changes.length === 1 ? "branch" : "branches"} ·{" "}
            {prCount} {prCount === 1 ? "PR" : "PRs"}
          </p>
        </div>
        <div className="rounded-xl border border-border-soft px-3 py-2.5">
          <p className="text-[11px] text-faint">Needs attention</p>
          <p className="mt-1 text-[13px]">
            {regressions > 0 ? (
              <StatusDot
                state="bad"
                label={`${regressions} regression${regressions === 1 ? "" : "s"}`}
              />
            ) : branches.length > 0 ? (
              <StatusDot state="ok" label="All verified" />
            ) : (
              <span className="text-faint">—</span>
            )}
          </p>
        </div>
        <div className="rounded-xl border border-border-soft px-3 py-2.5">
          <p className="text-[11px] text-faint">Suite</p>
          <p className="mt-1 text-[13px]">
            {repo.evals.length} {repo.evals.length === 1 ? "eval" : "evals"}
          </p>
        </div>
        <div className="rounded-xl border border-border-soft px-3 py-2.5">
          <p className="text-[11px] text-faint">Total spend</p>
          <p className="mt-1 font-mono text-[13px] tabular-nums">
            {fmtCost(spend)}
          </p>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="border-border-soft hover:bg-transparent">
            <TableHead className="text-[11px] font-normal text-faint">Change</TableHead>
            <TableHead className="text-[11px] font-normal text-faint">Claim</TableHead>
            <TableHead className="text-[11px] font-normal text-faint">
              State vs {repo.default_branch}
            </TableHead>
            <TableHead className="text-[11px] font-normal text-faint">Last review</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {changes.map((b) => {
            const s = branchStateDot(b);
            return (
              <TableRow
                key={b.name}
                onClick={() =>
                  router.push(
                    `/repo/${owner}/${name}/branches/${encodeURIComponent(b.name)}`,
                  )
                }
                className="cursor-pointer border-border-soft"
              >
                <TableCell className="font-mono text-xs">
                  <span className="inline-flex items-center gap-2">
                    {b.name}
                    {b.pr && (
                      <Badge variant="outline" className="rounded-full font-mono text-[10px] text-live">
                        PR #{b.pr.number}
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="max-w-64">
                  {b.pr?.claim ? (
                    <span className="block truncate text-xs italic text-muted-foreground">
                      “{b.pr.claim}”
                    </span>
                  ) : (
                    <span className="text-xs text-faint">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <StatusDot state={s.state} label={s.label} />
                </TableCell>
                <TableCell className="font-mono text-[11px] text-faint">
                  {b.last_review ? fmtRelative(b.last_review.t) : "—"}
                </TableCell>
              </TableRow>
            );
          })}
          {changes.length === 0 && (
            <TableRow className="border-border-soft hover:bg-transparent">
              <TableCell colSpan={4} className="py-6 text-center text-xs text-faint">
                no reviewed branches
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between gap-4 rounded-xl border border-border-soft px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">Connect your coding agent</p>
          <p className="mt-0.5 text-[11px] text-faint">
            The agent submits its branch for review before opening a PR.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(agentPrompt(repo));
            toast("Copied");
          }}
        >
          Copy prompt
        </Button>
      </div>
    </div>
  );
}
