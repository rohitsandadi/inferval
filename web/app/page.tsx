"use client";

// Home (wireframe screen 1): repo card grid under a wordmark topbar.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/status-dot";
import { getBranches, listRepos } from "@/lib/api";
import type { BranchInfo, RepoInfo } from "@/lib/types";

function RepoCard({
  repo,
  branches,
}: {
  repo: RepoInfo;
  branches: BranchInfo[] | undefined;
}) {
  const router = useRouter();
  const regressions =
    branches?.filter((b) => b.state === "regression").length ?? 0;
  const allVerified =
    branches !== undefined &&
    branches.length > 0 &&
    branches.every((b) => b.state === "verified");

  return (
    <div
      onClick={() => router.push(`/repo/${repo.name}`)}
      className="flex cursor-pointer flex-col gap-2.5 rounded-xl border border-border p-4 transition-colors hover:border-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-medium">{repo.name}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className="rounded-md p-0.5 text-faint hover:text-foreground"
            aria-label={`${repo.name} actions`}
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <DropdownMenuItem
              onClick={() => {
                navigator.clipboard.writeText(
                  `https://github.com/${repo.name}.git`,
                );
                toast("Copied");
              }}
            >
              Copy clone URL
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                window.open(`https://github.com/${repo.name}`, "_blank")
              }
            >
              Open on GitHub
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {repo.gpu && (
          <Badge variant="outline" className="rounded-full font-mono text-[10px] text-muted-foreground">
            {repo.gpu}
          </Badge>
        )}
        <Badge variant="outline" className="rounded-full font-mono text-[10px] text-muted-foreground">
          {repo.evals.length} {repo.evals.length === 1 ? "eval" : "evals"}
        </Badge>
        {branches !== undefined && branches.length > 0 && (
          <Badge variant="outline" className="rounded-full font-mono text-[10px] text-muted-foreground">
            {branches.length} {branches.length === 1 ? "branch" : "branches"}
          </Badge>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-faint">
        {regressions > 0 ? (
          <StatusDot
            state="bad"
            label={`${regressions} regression${regressions === 1 ? "" : "s"} open`}
          />
        ) : allVerified ? (
          <StatusDot state="ok" label="All verified" />
        ) : (
          <span>no reviews yet</span>
        )}
        {repo.runs_count > 0 && (
          <span>
            {repo.runs_count} {repo.runs_count === 1 ? "review" : "reviews"}
          </span>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [branchesByRepo, setBranchesByRepo] = useState<
    Record<string, BranchInfo[]>
  >({});
  const [query, setQuery] = useState("");

  useEffect(() => {
    listRepos().then((rs) => {
      setRepos(rs);
      rs.forEach((r) =>
        getBranches(r.name).then((bs) =>
          setBranchesByRepo((prev) => ({ ...prev, [r.name]: bs })),
        ),
      );
    });
  }, []);

  const visible = useMemo(
    () =>
      repos?.filter((r) =>
        r.name.toLowerCase().includes(query.trim().toLowerCase()),
      ) ?? null,
    [repos, query],
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border-soft px-4 py-2">
        <span className="text-[13px] font-semibold">Atlas</span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search repos…"
              className="h-8 w-52 pl-8 text-[13px]"
            />
          </div>
          <Button size="sm">Connect repo</Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-5">
        <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
          {visible === null &&
            [0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          {visible?.map((repo) => (
            <RepoCard
              key={repo.name}
              repo={repo}
              branches={branchesByRepo[repo.name]}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
