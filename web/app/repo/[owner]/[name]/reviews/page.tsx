"use client";

// Reviews — full log (wireframe screen 7): search + branch + verdict filters
// over every run; live rows refresh until done.

import { use, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { RunsTable, type RunExtras } from "@/components/runs-table";
import { useRepoShell } from "@/components/repo-shell";
import { getRun } from "@/lib/api";
import { queryKeys, useRunsQuery } from "@/lib/queries";
import { fmtCost } from "@/lib/format";

const ALL = "__all__";

export default function ReviewsPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const { repo } = useRepoShell();
  const { data: runsData } = useRunsQuery(repoName);
  const runs = runsData ?? null;
  const [query, setQuery] = useState("");
  const [branch, setBranch] = useState(ALL);
  const [verdict, setVerdict] = useState(ALL);

  const runQueries = useQueries({
    queries: (runs ?? []).map((run) => ({
      queryKey: queryKeys.run(run.run),
      queryFn: () => getRun(run.run),
      staleTime: run.status === "done" ? 5 * 60_000 : 0,
    })),
  });
  const extras = useMemo<Record<string, RunExtras>>(
    () =>
      Object.fromEntries(
        (runs ?? []).flatMap((run, index) => {
          const detail = runQueries[index]?.data;
          return detail
            ? [[run.run, { evals: detail.spec.evals.length, gpu: detail.spec.gpu }]]
            : [];
        }),
      ),
    [runs, runQueries],
  );

  const branches = useMemo(() => {
    const set = new Set<string>();
    runs?.forEach((r) => r.branch && set.add(r.branch));
    return [...set];
  }, [runs]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (
      runs?.filter((r) => {
        if (branch !== ALL && r.branch !== branch) return false;
        if (verdict === "running" && r.status === "done") return false;
        if (
          verdict !== ALL &&
          verdict !== "running" &&
          r.verdict !== verdict
        )
          return false;
        if (
          q &&
          !r.run.toLowerCase().includes(q) &&
          !(r.branch ?? "").toLowerCase().includes(q) &&
          !(r.claim ?? "").toLowerCase().includes(q)
        )
          return false;
        return true;
      }) ?? null
    );
  }, [runs, query, branch, verdict]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search reviews…"
            className="h-7 w-52 pl-8 text-xs"
          />
        </div>
        <Select
          value={branch}
          onValueChange={(v) => setBranch(v as string)}
          items={{
            [ALL]: "All branches",
            ...Object.fromEntries(branches.map((b) => [b, b])),
          }}
        >
          <SelectTrigger size="sm" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              All branches
            </SelectItem>
            {branches.map((b) => (
              <SelectItem key={b} value={b} className="font-mono text-xs">
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={verdict}
          onValueChange={(v) => setVerdict(v as string)}
          items={{
            [ALL]: "All verdicts",
            pass: "Pass",
            regression: "Regression",
            invalid: "Invalid",
            running: "Running",
          }}
        >
          <SelectTrigger size="sm" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              All verdicts
            </SelectItem>
            <SelectItem value="pass" className="text-xs">
              Pass
            </SelectItem>
            <SelectItem value="regression" className="text-xs">
              Regression
            </SelectItem>
            <SelectItem value="invalid" className="text-xs">
              Invalid
            </SelectItem>
            <SelectItem value="running" className="text-xs">
              Running
            </SelectItem>
          </SelectContent>
        </Select>
        {runs && (
          <span className="ml-auto text-[11px] text-faint">
            {runs.length} {runs.length === 1 ? "review" : "reviews"} ·{" "}
            {fmtCost(runs.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0))} total
          </span>
        )}
      </div>

      {visible === null ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <RunsTable
          repoName={repoName}
          runs={visible}
          baseLabel={repo?.default_branch}
          extras={extras}
        />
      )}
    </div>
  );
}
