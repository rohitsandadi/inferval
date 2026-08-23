"use client";

// Branches & PRs (wireframe screen 3): base selector + search over the merged
// branch/PR list; every state is relative to the selected base.

import { use, useEffect, useMemo, useState } from "react";
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
import { getBranches } from "@/lib/api";
import type { BranchInfo } from "@/lib/types";

export default function BranchesPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const router = useRouter();
  const { repo, branches: allBranches, openNewReview } = useRepoShell();
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;

  const [baseChoice, setBaseChoice] = useState<string | null>(null);
  const base = baseChoice ?? repo?.default_branch ?? null;
  const [rows, setRows] = useState<BranchInfo[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (base === null) return;
    let alive = true;
    setRows(null);
    getBranches(repoName, base).then((bs) => {
      if (alive) setRows(bs);
    });
    return () => {
      alive = false;
    };
  }, [repoName, base]);

  const baseOptions = useMemo(() => {
    const set = new Set<string>();
    if (repo?.default_branch) set.add(repo.default_branch);
    allBranches.forEach((b) => set.add(b.name));
    return [...set];
  }, [repo, allBranches]);

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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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
            className="h-7 w-52 pl-8 text-xs"
          />
        </div>
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
              <TableHead className="text-[11px] font-normal text-faint">Branch</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">Claim</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">vs {base}</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">Reviews</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((b) => {
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
                  <TableCell className="max-w-72">
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
                  <TableCell className="font-mono text-xs tabular-nums">
                    {b.reviews_count}
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow className="border-border-soft hover:bg-transparent">
                <TableCell colSpan={5} className="py-6 text-center text-xs text-faint">
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
