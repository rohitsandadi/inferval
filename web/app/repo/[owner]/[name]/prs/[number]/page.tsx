"use client";

// PR resolver: /prs/{number} finds (or creates) the session attached to that
// PR and redirects to the session page — the PR page IS the session page.

import { use, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { createSession } from "@/lib/api";
import { queryKeys, useSessionsQuery } from "@/lib/queries";

export default function PrResolverPage({
  params,
}: {
  params: Promise<{ owner: string; name: string; number: string }>;
}) {
  const { owner, name, number } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const router = useRouter();
  const queryClient = useQueryClient();
  const pr = parseInt(number, 10);
  const { data: sessions, isPending } = useSessionsQuery(repoName);
  const creating = useRef(false);
  const createMutation = useMutation({
    mutationFn: () => createSession(repoName, { pr }),
    onSuccess: async ({ session }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions(repoName) });
      router.replace(`/repo/${owner}/${name}/sessions/${session}`);
    },
  });

  useEffect(() => {
    if (isPending || !sessions) return;
    const existing = sessions.find((session) => session.pr?.number === pr);
    if (existing) {
      router.replace(`/repo/${owner}/${name}/sessions/${existing.session}`);
    } else if (!creating.current) {
      creating.current = true;
      createMutation.mutate();
    }
  }, [isPending, sessions, pr, router, owner, name, createMutation]);

  return (
    <div className="space-y-3 p-5">
      <Skeleton className="h-6 w-96" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
