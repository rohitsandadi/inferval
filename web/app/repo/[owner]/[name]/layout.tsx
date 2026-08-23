"use client";

// Repo shell (wireframe screens 2–12): breadcrumb topbar with the page's one
// primary button, left sidebar, content to the right.

import {
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Brand } from "@/components/brand";
import { NewReviewDialog } from "@/components/new-review-dialog";
import { RepoSidebar } from "@/components/repo-sidebar";
import { RepoShellContext, type Crumb } from "@/components/repo-shell";
import { queryKeys, useBranchesQuery, useRepoQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export default function RepoLayout({
  children,
  params,
}: LayoutProps<"/repo/[owner]/[name]">) {
  const { owner, name } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const base = `/repo/${owner}/${name}`;
  const pathname = usePathname();

  const queryClient = useQueryClient();
  const { data: repoData } = useRepoQuery(repoName);
  const { data: branchesData } = useBranchesQuery(repoName);
  const repo = repoData ?? null;
  const branches = useMemo(() => branchesData ?? [], [branchesData]);
  const [crumbs, setCrumbs] = useState<Crumb[] | null>(null);
  const [topbarRight, setTopbarRight] = useState<ReactNode | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultHead, setDefaultHead] = useState<string | undefined>(undefined);

  const openNewReview = useCallback((head?: string) => {
    setDefaultHead(head);
    setDialogOpen(true);
  }, []);

  const refreshRuns = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.runs(repoName) });
    queryClient.invalidateQueries({
      queryKey: [...queryKeys.all, "branches", repoName],
    });
  }, [queryClient, repoName]);

  const shell = useMemo(
    () => ({
      repo,
      branches,
      openNewReview,
      setCrumbs,
      setTopbarRight,
      refreshRuns,
    }),
    [repo, branches, openNewReview, refreshRuns],
  );

  // Default extra crumbs from the path: branch and review ids render mono.
  const autoCrumbs = useMemo<Crumb[]>(() => {
    const rest = pathname.startsWith(base)
      ? pathname.slice(base.length).split("/").filter(Boolean)
      : [];
    if ((rest[0] === "branches" || rest[0] === "reviews") && rest[1])
      return [{ label: decodeURIComponent(rest[1]), mono: true }];
    return [];
  }, [pathname, base]);

  const extraCrumbs = crumbs ?? autoCrumbs;

  const workspace =
    pathname.includes("/sessions/") || pathname.includes("/prs/");

  return (
    <RepoShellContext.Provider value={shell}>
      <div
        className={cn(
          "flex flex-col",
          workspace ? "h-dvh overflow-hidden" : "min-h-dvh",
        )}
      >
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border-soft bg-sidebar px-6 py-3">
          <nav className="flex min-w-0 items-center gap-2.5 text-sm">
            <Brand className="mr-1" />
            <span className="text-faint">/</span>
            <Link
              href={base}
              className={cn(
                "truncate text-muted-foreground hover:text-foreground",
                extraCrumbs.length === 0 && "font-medium text-foreground",
              )}
            >
              {repoName}
            </Link>
            {extraCrumbs.map((c, i) => (
              <span key={i} className="flex min-w-0 items-center gap-2">
                <span className="text-faint">/</span>
                {c.href ? (
                  <Link
                    href={c.href}
                    className={cn(
                      "truncate text-muted-foreground hover:text-foreground",
                      c.mono && "font-mono text-xs",
                    )}
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span
                    className={cn(
                      "truncate text-foreground",
                      c.mono && "font-mono text-xs",
                    )}
                  >
                    {c.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
          {topbarRight ?? (
            <Button size="sm" onClick={() => openNewReview()}>
              New review
            </Button>
          )}
        </header>
        {/* The PR/session workspace is full-bleed: no sidebar, no padding. */}
        {workspace ? (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {children}
          </main>
        ) : (
          <div className="flex flex-1 max-md:flex-col">
            <RepoSidebar owner={owner} name={name} />
            <main className="min-w-0 flex-1 px-8 py-8 max-lg:px-5">
              <div className="mx-auto max-w-[1420px]">{children}</div>
            </main>
          </div>
        )}
      </div>
      {repo && (
        <NewReviewDialog
          repo={repo}
          branches={branches}
          defaultHead={defaultHead}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </RepoShellContext.Provider>
  );
}
