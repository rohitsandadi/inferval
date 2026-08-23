"use client";

// PR resolver: /prs/{number} finds (or creates) the session attached to that
// PR and redirects to the session page — the PR page IS the session page.

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { createSession, listSessions } from "@/lib/api";

export default function PrResolverPage({
  params,
}: {
  params: Promise<{ owner: string; name: string; number: string }>;
}) {
  const { owner, name, number } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    (async () => {
      const pr = parseInt(number, 10);
      const sessions = await listSessions(repoName);
      const existing = sessions.find((s) => s.pr?.number === pr);
      const id = existing
        ? existing.session
        : (await createSession(repoName, { pr })).session;
      if (alive) router.replace(`/repo/${owner}/${name}/sessions/${id}`);
    })();
    return () => {
      alive = false;
    };
  }, [repoName, owner, name, number, router]);

  return (
    <div className="space-y-3 p-5">
      <Skeleton className="h-6 w-96" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
