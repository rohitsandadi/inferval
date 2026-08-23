"use client";

// Connect GitHub + repo picker. The token never reaches the browser: the
// button is a full-page redirect through the API's OAuth routes, and the
// picker proxies the account's repo list server-side.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { connectRepo, githubLoginUrl, isMock } from "@/lib/api";
import {
  queryKeys,
  useGithubReposQuery,
} from "@/lib/queries";
import { Input } from "@/components/ui/input";
import { fmtRelative } from "@/lib/format";
import type { GithubStatus } from "@/lib/types";

export function ConnectRepoDialog({
  open,
  onOpenChange,
  gh,
  connectedNames,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  gh: GithubStatus | null;
  connectedNames: string[];
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [added, setAdded] = useState<string[]>([]);
  const [publicName, setPublicName] = useState("");
  const { data: repoData, isPending: reposPending } = useGithubReposQuery(
    open && Boolean(gh?.connected),
  );
  const repos = repoData ?? null;
  const connectMutation = useMutation({
    mutationFn: connectRepo,
    onSuccess: async (repo) => {
      setAdded((current) => [...current, repo.name]);
      setPublicName("");
      toast(`${repo.name} connected`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos() });
      onConnected();
    },
  });
  const busy = connectMutation.isPending
    ? (connectMutation.variables ?? null)
    : null;

  const addPublic = async () => {
    const name = publicName.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) {
      toast("Use the owner/repo form");
      return;
    }
    await connectMutation.mutateAsync(name);
  };

  const taken = new Set([...connectedNames, ...added]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect repo</DialogTitle>
          <DialogDescription>
            {gh?.connected
              ? `GitHub: ${gh.login}`
              : "Connect your GitHub account to pick a repo."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            value={publicName}
            onChange={(e) => setPublicName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPublic()}
            placeholder="Public repo: owner/repo"
            className="h-9 font-mono text-sm"
            disabled={isMock}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={isMock || busy !== null || !publicName.trim()}
            onClick={addPublic}
          >
            Add
          </Button>
        </div>
        {!gh?.connected ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={isMock}
              onClick={() => {
                const url = githubLoginUrl();
                if (url) window.location.href = url;
              }}
            >
              Connect GitHub
            </Button>
          </div>
        ) : reposPending || repos === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {repos.map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border-soft px-3 py-2"
              >
                <div className="min-w-0">
                  <span className="block truncate font-mono text-xs">{r.name}</span>
                  <span className="text-[13px] text-faint">
                    {r.default_branch}
                    {r.pushed_at ? ` · ${fmtRelative(r.pushed_at)}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {r.private && (
                    <Badge variant="outline" className="rounded-full font-mono text-[12px] text-muted-foreground">
                      private
                    </Badge>
                  )}
                  {taken.has(r.name) ? (
                    <span className="text-[13px] text-faint">connected</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === r.name}
                      onClick={async () => {
                        await connectMutation.mutateAsync(r.name);
                      }}
                    >
                      {busy === r.name ? "Connecting…" : "Connect"}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {repos.length === 0 && (
              <p className="py-4 text-center text-xs text-faint">no repos returned</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
