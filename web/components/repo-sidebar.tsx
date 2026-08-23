"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function RepoSidebar({ owner, name }: { owner: string; name: string }) {
  const pathname = usePathname();
  const base = `/repo/${owner}/${name}`;
  const items = [
    { label: "Overview", href: base, exact: true },
    { label: "Branches & PRs", href: `${base}/branches`, exact: false },
    { label: "Reviews", href: `${base}/reviews`, exact: false },
    { label: "Evals", href: `${base}/evals`, exact: false },
    { label: "Sandboxes", href: `${base}/sandboxes`, exact: false },
  ];
  return (
    <nav className="flex w-[220px] shrink-0 flex-col gap-1.5 border-r border-border-soft bg-sidebar px-4 py-6 max-md:w-full max-md:flex-row max-md:flex-wrap max-md:border-r-0 max-md:border-b max-md:py-3">
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-lg border border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground",
              active && "border-border bg-surface text-foreground shadow-sm",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
