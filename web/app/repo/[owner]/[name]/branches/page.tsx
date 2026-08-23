"use client";

// Branches & PRs (wireframe-v3 screen 9): base selector + search; sub-lines
// carry sha/age, the Risks column ties triage in, and each row offers Test
// (opens the change's session) and Review (formal run).

import { use, useCallback, useMemo, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useRepoShell } from "@/components/repo-shell";
import {
  createSession,
  getSession,
} from "@/lib/api";
import {
  queryKeys,
  useBranchesQuery,
  useRunsQuery,
  useSessionsQuery,
} from "@/lib/queries";
import { fmtCost } from "@/lib/format";
import type {
  Annotation,
  BranchInfo,
  SessionSummary,
} from "@/lib/types";

interface RiskSummary {
  total: number;
  gaps: number;
}

export default function BranchesPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { repo, branches: allBranches, openNewReview } = useRepoShell();
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;

  const [baseChoice, setBaseChoice] = useState<string | null>(null);
  const base = baseChoice ?? repo?.default_branch ?? null;
  const [query, setQuery] = useState("");
  const { data: rowsData } = useBranchesQuery(repoName, base ?? undefined);
  const { data: runs = [] } = useRunsQuery(repoName);
  const { data: sessions = [] } = useSessionsQuery(repoName);
  const sessionQueries = useQueries({
    queries: sessions.map((session) => ({
      queryKey: queryKeys.session(session.session),
      queryFn: () => getSession(session.session),
      staleTime: 30_000,
    })),
  });
  const rows: BranchInfo[] | null = base === null ? null : (rowsData ?? null);
  const risksBySession = useMemo<Record<string, RiskSummary>>(
    () =>
      Object.fromEntries(
        sessions.flatMap((session, index) => {
          const anns: Annotation[] = sessionQueries[index]?.data?.triage ?? [];
          return anns.length
            ? [[session.session, {
                total: anns.length,
                gaps: anns.filter((annotation) => annotation.coverage === "gap").length,
              }]]
            : [];
        }),
      ),
    [sessions, sessionQueries],
  );
  const createSessionMutation = useMutation({
    mutationFn: (branch: string) => createSession(repoName, { branch }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions(repoName) }),
  });

  const baseOptions = useMemo(() => {
    const set = new Set<string>();
    if (repo?.default_branch) set.add(repo.default_branch);
    allBranches.forEach((b) => set.add(b.name));
    return [...set];
  }, [repo, allBranches]);

  const costByBranch = useMemo(() => {
    const m = new Map<string, number>();
    runs.forEach((r) => {
      if (r.branch) m.set(r.branch, (m.get(r.branch) ?? 0) + (r.cost_usd ?? 0));
    });
    return m;
  }, [runs]);

  const sessionFor = useCallback(
    (b: BranchInfo): SessionSummary | undefined =>
      sessions.find(
        (s) =>
          (b.pr && s.pr?.number === b.pr.number) || s.branch === b.name,
      ),
    [sessions],
  );

  // Test = open the change's session (create one when none exists yet).
  const openTest = useCallback(
    async (b: BranchInfo) => {
      if (b.pr) {
        router.push(`/repo/${owner}/${name}/prs/${b.pr.number}`);
        return;
      }
      const existing = sessionFor(b);
      const id = existing
        ? existing.session
        : (await createSessionMutation.mutateAsync(b.name)).session;
      router.push(`/repo/${owner}/${name}/sessions/${id}`);
    },
    [router, owner, name, sessionFor, createSessionMutation],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return (
      rows?.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.pr?.title.toLowerCase().includes(q),
      ) ?? null
    );
  }, [rows, query]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={base ?? ""}
          onValueChange={(v) => setBaseChoice(v as string)}
        >
          <SelectTrigger size="sm" className="min-w-40">
            <span className="text-muted-foreground">Base:</span>
            <SelectValue className="font-mono text-xs" />
          </SelectTrigger>
          <SelectContent>
            {baseOptions.map((b) => (
              <SelectItem key={b} value={b} className="font-mono text-xs">
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search branches…"
            className="h-9 w-64 pl-9 text-sm"
          />
        </div>
        {rows && (
          <span className="ml-auto text-[13px] text-faint">
            {rows.length} {rows.length === 1 ? "branch" : "branches"} ·{" "}
            {rows.filter((b) => b.pr).length} PRs
          </span>
        )}
      </div>

      {visible === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="border-border-soft hover:bg-transparent">
              <TableHead className="text-[13px] font-normal text-faint">Branch</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Claim</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">vs {base}</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Risks</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Reviews</TableHead>
              <TableHead className="text-[13px] font-normal text-faint">Cost</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((b) => {
              const s = branchStateDot(b);
              const sess = sessionFor(b);
              const risks = sess ? risksBySession[sess.session] : undefined;
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
                  <TableCell>
                    <span className="inline-flex items-center gap-2 font-mono text-xs">
                      {b.name}
                      {b.pr && (
                        <Badge
                          variant="outline"
                          className="rounded-full border-live/45 bg-live/10 font-mono text-[12px] text-live"
                        >
                          PR #{b.pr.number}
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] text-faint">
                      {b.sha}
                      {b.last_review ? ` · ${fmtRelativeShort(b.last_review.t)}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-56">
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
                  <TableCell className="font-mono text-xs">
                    {risks ? (
                      risks.gaps > 0 ? (
                        <span>
                          {risks.total} ·{" "}
                          <span className="text-note">
                            {risks.gaps} gap→eval
                          </span>
                        </span>
                      ) : (
                        `${risks.total} · covered`
                      )
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {b.reviews_count}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {fmtCost(costByBranch.get(b.name) ?? 0)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex gap-1.5">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          openTest(b);
                        }}
                      >
                        Test
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          openNewReview(b.name);
                        }}
                      >
                        Review
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow className="border-border-soft hover:bg-transparent">
                <TableCell colSpan={7} className="py-6 text-center text-xs text-faint">
                  no branches
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function fmtRelativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 45_000) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
