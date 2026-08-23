"use client";

// Repo shell (wireframe screens 2–12): breadcrumb topbar with the page's one
// primary button, left sidebar, content to the right.

import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { NewReviewDialog } from "@/components/new-review-dialog";
import { RepoSidebar } from "@/components/repo-sidebar";
import { RepoShellContext, type Crumb } from "@/components/repo-shell";
import { getBranches, getRepo } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { BranchInfo, RepoInfo } from "@/lib/types";

export default function RepoLayout({
  children,
  params,
}: LayoutProps<"/repo/[owner]/[name]">) {
  const { owner, name } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const base = `/repo/${owner}/${name}`;
  const pathname = usePathname();

  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [crumbs, setCrumbs] = useState<Crumb[] | null>(null);
  const [topbarRight, setTopbarRight] = useState<ReactNode | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultHead, setDefaultHead] = useState<string | undefined>(undefined);
  const [runsVersion, setRunsVersion] = useState(0);

  useEffect(() => {
    getRepo(repoName).then((r) => setRepo(r ?? null));
    getBranches(repoName).then(setBranches);
  }, [repoName]);

  const openNewReview = useCallback((head?: string) => {
    setDefaultHead(head);
    setDialogOpen(true);
  }, []);

  const refreshRuns = useCallback(() => setRunsVersion((v) => v + 1), []);

  const shell = useMemo(
    () => ({
      repo,
      branches,
      openNewReview,
      setCrumbs,
      setTopbarRight,
      refreshRuns,
      runsVersion,
    }),
    [repo, branches, openNewReview, refreshRuns, runsVersion],
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
        <header className="flex items-center justify-between gap-3 border-b border-border-soft px-4 py-2">
          <nav className="flex min-w-0 items-center gap-2 text-[13px]">
            <Link href="/" className="font-semibold text-foreground">
              Atlas
            </Link>
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
            <main className="min-w-0 flex-1 px-6 py-5">
              <div className="mx-auto max-w-[1240px]">{children}</div>
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
