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
    <nav className="flex w-[170px] shrink-0 flex-col gap-0.5 border-r border-border-soft px-2.5 py-3 max-md:w-full max-md:flex-row max-md:flex-wrap max-md:border-r-0 max-md:border-b">
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-md border border-transparent px-2.5 py-1 text-[13px] text-muted-foreground hover:text-foreground",
              active && "border-border-soft bg-surface text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
