"use client";

// Repo overview (wireframe-v3 screen 8): pin line, six-stat strip, sandbox
// status strip, then changes table + activity feed in two columns.

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Delta } from "@/components/atoms";
import { agentPrompt } from "@/components/agent-prompt";
import { useRepoShell } from "@/components/repo-shell";
import {
  listGapBornEvals,
  listRuns,
  listSandboxes,
  listSessions,
} from "@/lib/api";
import {
  fmtClock,
  fmtCost,
  fmtRelative,
  looksLikeSha,
  shortSha,
} from "@/lib/format";
import type { RunSummary, SandboxInfo, SessionSummary } from "@/lib/types";

function relShort(iso: string): string {
  const r = fmtRelative(iso);
  return r === "now" ? "now" : r.replace(" ago", "");
}

interface FeedItem {
  t: string;
  node: React.ReactNode;
}

export default function OverviewPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const router = useRouter();
  const { repo, branches, runsVersion } = useRepoShell();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [sandboxes, setSandboxes] = useState<SandboxInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [gapBorn, setGapBorn] = useState(0);

  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  useEffect(() => {
    listRuns(repoName).then(setRuns);
  }, [repoName, runsVersion]);
  useEffect(() => {
    listSandboxes(repoName).then(setSandboxes);
    listSessions(repoName).then(setSessions);
    listGapBornEvals(repoName).then((g) => setGapBorn(g.length));
  }, [repoName]);

  const changes = useMemo(
    () => branches.filter((b) => b.reviews_count > 0),
    [branches],
  );
  const prCount = changes.filter((b) => b.pr).length;
  const regressions = branches.filter((b) => b.state === "regression").length;
  const spend = useMemo(
    () => (runs ?? []).reduce((acc, r) => acc + (r.cost_usd ?? 0), 0),
    [runs],
  );
  const baseSha = runs?.map((r) => r.base_sha).find(looksLikeSha);
  const latest = runs?.[0];
  const activeSandboxes = sandboxes.filter((s) => s.state !== "terminated");
  const runningCount = sandboxes.filter((s) => s.state === "running").length;
  const coolCount = sandboxes.filter((s) => s.state === "cooldown").length;

  const costByBranch = useMemo(() => {
    const m = new Map<string, number>();
    (runs ?? []).forEach((r) => {
      if (r.branch)
        m.set(r.branch, (m.get(r.branch) ?? 0) + (r.cost_usd ?? 0));
    });
    return m;
  }, [runs]);

  const lastByBranch = useMemo(() => {
    const m = new Map<string, string>();
    (runs ?? []).forEach((r) => {
      if (r.branch && !m.has(r.branch)) m.set(r.branch, r.created_at);
    });
    return m;
  }, [runs]);

  // Activity: reviews (created / verdict) + sessions (attached), newest first.
  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    (runs ?? []).forEach((r) => {
      if (r.verdict !== null) {
        const t = r.duration_s
          ? new Date(
              new Date(r.created_at).getTime() + r.duration_s * 1000,
            ).toISOString()
          : r.created_at;
        items.push({
          t,
          node: (
            <>
              <span className="font-mono text-[10px]">{r.run}</span> verdict —{" "}
              {r.verdict === "pass" ? "Pass" : r.verdict === "invalid" ? "Invalid" : "Regression"}{" "}
              <Delta
                pct={r.tokens_per_s_delta_pct}
                tone={
                  (r.tokens_per_s_delta_pct ?? 0) < -3
                    ? "bad"
                    : (r.tokens_per_s_delta_pct ?? 0) > 3
                      ? "good"
                      : "neutral"
                }
                className="text-[10px]"
              />
            </>
          ),
        });
      } else {
        items.push({
          t: r.created_at,
          node: (
            <>
              <span className="font-mono text-[10px]">{r.run}</span> {r.status}
              {r.branch ? ` ${r.branch}` : ""}
              {r.head_sha ? (
                <span className="font-mono text-[10px]">
                  {" "}
                  @ {shortSha(r.head_sha)}
                </span>
              ) : null}
            </>
          ),
        });
      }
    });
    sessions.forEach((s) => {
      items.push({
        t: s.created_at,
        node: (
          <>
            session <span className="font-mono text-[10px]">{s.session}</span>{" "}
            attached {s.pr ? `PR #${s.pr.number}` : (s.branch ?? "")}
          </>
        ),
      });
    });
    items.sort((a, b) => new Date(b.t).getTime() - new Date(a.t).getTime());
    return items.slice(0, 8);
  }, [runs, sessions]);

  if (!repo) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-6 gap-2 max-md:grid-cols-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] text-faint">
        base {repo.default_branch}
        {baseSha ? ` @ ${shortSha(baseSha)}` : ""} · {repo.image} · {repo.gpu}
      </p>

      <div className="grid grid-cols-6 gap-2 max-md:grid-cols-3 max-sm:grid-cols-2">
        <div className="rounded-lg border border-border-soft px-2.5 py-2">
          <p className="text-[10.5px] text-faint">Open changes</p>
          <p className="mt-0.5 text-xs">
            {changes.length} br · {prCount} PR{prCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="rounded-lg border border-border-soft px-2.5 py-2">
          <p className="text-[10.5px] text-faint">Needs attention</p>
          <p className="mt-0.5 text-xs">
            {regressions > 0 ? (
              <StatusDot
                state="bad"
                label={`${regressions} regression${regressions === 1 ? "" : "s"}`}
              />
            ) : branches.length > 0 ? (
              <StatusDot state="ok" label="All verified" />
            ) : (
              <span className="text-faint">—</span>
            )}
          </p>
        </div>
        <div className="rounded-lg border border-border-soft px-2.5 py-2">
          <p className="text-[10.5px] text-faint">Suite</p>
          <p className="mt-0.5 text-xs">
            {repo.evals.length + gapBorn} evals
            {gapBorn > 0 ? ` · ${gapBorn} gap-born` : ""}
          </p>
        </div>
        <div className="rounded-lg border border-border-soft px-2.5 py-2">
          <p className="text-[10.5px] text-faint">Sandboxes</p>
          <p className="mt-0.5 text-xs">
            {sandboxes.length === 0 ? (
              <span className="text-faint">—</span>
            ) : (
              `${runningCount} run · ${coolCount} cool`
            )}
          </p>
        </div>
        <div className="rounded-lg border border-border-soft px-2.5 py-2">
          <p className="text-[10.5px] text-faint">Spend</p>
          <p className="mt-0.5 font-mono text-xs tabular-nums">
            {fmtCost(spend)}
          </p>
        </div>
        <div className="rounded-lg border border-border-soft px-2.5 py-2">
          <p className="text-[10.5px] text-faint">Last review</p>
          <p className="mt-0.5 font-mono text-xs tabular-nums">
            {latest
              ? `${relShort(latest.created_at)}${latest.cost_usd != null ? ` · ${fmtCost(latest.cost_usd)}` : ""}`
              : "—"}
          </p>
        </div>
      </div>

      {activeSandboxes.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border-soft px-3 py-1.5 text-[11px]">
          {activeSandboxes.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1.5">
              <i
                className={
                  "size-[7px] rounded-full " +
                  (s.state === "running" ? "bg-live" : "bg-faint")
                }
                aria-hidden
              />
              <span className="font-mono text-[10.5px]">{s.id}</span>
              <span className="text-muted-foreground">
                {s.gpu ?? "CPU"}
                {s.state === "running" && s.uptime_s !== null
                  ? ` · ${fmtClock(s.uptime_s)}`
                  : ""}
                {s.state === "cooldown" && s.deadline !== null
                  ? ` · cooldown ${fmtClock(s.deadline - Date.now() / 1000)}`
                  : ""}
                {s.attached?.session ? (
                  <span className="font-mono text-[10.5px]">
                    {" "}
                    · {s.attached.session}
                  </span>
                ) : s.attached?.run ? (
                  <span className="font-mono text-[10.5px]">
                    {" "}
                    · {s.attached.run}
                  </span>
                ) : null}
              </span>
            </span>
          ))}
          <Link
            href={`/repo/${owner}/${name}/sandboxes`}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            Sandboxes →
          </Link>
        </div>
      )}

      <div className="grid grid-cols-[1fr_300px] items-start gap-4 max-md:grid-cols-1">
        <div>
          <Table>
            <TableHeader>
              <TableRow className="border-border-soft hover:bg-transparent">
                <TableHead className="text-[11px] font-normal text-faint">Change</TableHead>
                <TableHead className="text-[11px] font-normal text-faint">Claim</TableHead>
                <TableHead className="text-[11px] font-normal text-faint">
                  vs {repo.default_branch}
                </TableHead>
                <TableHead className="text-[11px] font-normal text-faint">Last</TableHead>
                <TableHead className="text-right text-[11px] font-normal text-faint">
                  Cost
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((b) => {
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
                          <Badge
                            variant="outline"
                            className="rounded-full border-live/45 bg-live/10 font-mono text-[10px] text-live"
                          >
                            PR #{b.pr.number}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-52">
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
                    <TableCell className="font-mono text-[11px] text-faint">
                      {b.last_review
                        ? relShort(b.last_review.t)
                        : lastByBranch.has(b.name)
                          ? relShort(lastByBranch.get(b.name)!)
                          : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {fmtCost(costByBranch.get(b.name) ?? 0)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {changes.length === 0 && (
                <TableRow className="border-border-soft hover:bg-transparent">
                  <TableCell
                    colSpan={5}
                    className="py-6 text-center text-xs text-faint"
                  >
                    no reviewed branches
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-border-soft px-3 py-2">
            <p className="min-w-0 text-[11px] text-muted-foreground">
              Connect your coding agent — it submits branches for review before
              opening PRs.
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(agentPrompt(repo));
                toast("Copied");
              }}
            >
              Copy prompt
            </Button>
          </div>
        </div>

        <div className="border-l border-border-soft pl-3.5 max-md:border-l-0 max-md:pl-0">
          <p className="text-[10.5px] uppercase tracking-wide text-faint">
            Activity
          </p>
          <div className="mt-1">
            {feed.map((item, i) => (
              <div
                key={i}
                className="flex items-baseline gap-2 border-b border-border-soft py-1.5 text-[11px] last:border-b-0"
              >
                <span className="w-8 shrink-0 font-mono text-[9.5px] text-faint">
                  {relShort(item.t)}
                </span>
                <span className="min-w-0 text-muted-foreground">
                  {item.node}
                </span>
              </div>
            ))}
            {feed.length === 0 && (
              <p className="py-2 text-[11px] text-faint">no activity</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
