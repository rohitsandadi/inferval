"use client";

// Sandboxes (wireframe-v3 screen 4): the warm-pool registry as a table —
// state dots, cooldown countdowns, Stop / Keep-warm controls — plus the
// sandbox_exec activity feed of session-attached boxes.

import { use, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusDot } from "@/components/status-dot";
import { useRepoShell } from "@/components/repo-shell";
import {
  sandboxAction,
} from "@/lib/api";
import {
  queryKeys,
  useSandboxesQuery,
  useSessionEventsQuery,
  useSessionsQuery,
} from "@/lib/queries";
import { fmtClock, fmtTime } from "@/lib/format";
import type { SandboxInfo } from "@/lib/types";

const EXTEND_S = 600;

function Countdown({ deadline }: { deadline: number }) {
  const [left, setLeft] = useState(() => deadline - Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setLeft(deadline - Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  if (left <= 0) return null;
  return (
    <span className="text-faint">
      {" · "}
      <span className="font-mono tabular-nums">{fmtClock(left)}</span>
    </span>
  );
}

function Uptime({ row }: { row: SandboxInfo }) {
  // Running boxes tick; everything else is a frozen number from the registry.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (row.state !== "running" || !row.created_at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [row.state, row.created_at]);
  const s =
    row.state === "running" && row.created_at
      ? (now - new Date(row.created_at).getTime()) / 1000
      : row.uptime_s;
  return (
    <span className="font-mono tabular-nums">
      {s === null || s === undefined ? "—" : fmtClock(s)}
    </span>
  );
}

export default function SandboxesPage({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = use(params);
  const repoName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  const { setTopbarRight } = useRepoShell();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"active" | "all">("active");
  const { data: rowsData, isPending } = useSandboxesQuery(repoName);
  const { data: sessions = [] } = useSessionsQuery(repoName);
  const rows = rowsData ?? null;
  const target = rows?.find(
    (row) => row.attached?.session && row.state !== "terminated",
  );
  const targetSession = target?.attached?.session ?? "";
  const { data: targetEvents = [] } = useSessionEventsQuery(targetSession);
  const feed = target
    ? {
        sandbox: target.id,
        session: targetSession,
        events: targetEvents.filter((event) => event.kind === "sandbox_exec"),
      }
    : null;
  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "stop" | "extend" }) =>
      sandboxAction(id, action),
    onMutate: ({ id, action }) => {
      queryClient.setQueryData(queryKeys.sandboxes(repoName), (current: typeof rowsData) =>
        current?.map((row) =>
          row.id !== id
            ? row
            : action === "stop"
              ? { ...row, state: "terminated" as const, uptime_s: null }
              : { ...row, deadline: (row.deadline ?? Date.now() / 1000) + EXTEND_S },
        ),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes(repoName) }),
  });

  const gpuSecondsToday = useMemo(
    () =>
      (rows ?? []).reduce(
        (acc, r) => acc + (r.gpu && r.gpu !== "cpu" ? (r.uptime_s ?? 0) : 0),
        0,
      ),
    [rows],
  );

  useEffect(() => {
    setTopbarRight(
      <span className="font-mono text-[11px] text-faint">
        {gpuSecondsToday} GPU-s today
      </span>,
    );
    return () => setTopbarRight(null);
  }, [setTopbarRight, gpuSecondsToday]);

  const prBySession = useMemo(() => {
    const m = new Map<string, number>();
    sessions.forEach((s) => {
      if (s.pr) m.set(s.session, s.pr.number);
    });
    return m;
  }, [sessions]);

  const visible = useMemo(
    () =>
      tab === "all"
        ? rows
        : (rows?.filter((r) => r.state !== "terminated") ?? null),
    [rows, tab],
  );

  const act = async (id: string, action: "stop" | "extend") => {
    await actionMutation.mutateAsync({ id, action });
  };

  return (
    <div className="space-y-3">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "active" | "all")}>
        <TabsList>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {visible === null || isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="border-border-soft hover:bg-transparent">
              <TableHead className="text-[11px] font-normal text-faint">Sandbox</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">GPU</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">State</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">Uptime</TableHead>
              <TableHead className="text-[11px] font-normal text-faint">Attached to</TableHead>
              <TableHead className="text-right text-[11px] font-normal text-faint">
                GPU-s
              </TableHead>
              <TableHead className="text-right text-[11px] font-normal text-faint" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => {
              const terminated = r.state === "terminated";
              const gpuS =
                r.gpu && r.gpu !== "cpu" && r.uptime_s !== null
                  ? Math.round(r.uptime_s)
                  : null;
              return (
                <TableRow
                  key={r.id}
                  className={
                    terminated
                      ? "border-border-soft opacity-50 hover:bg-transparent"
                      : "border-border-soft hover:bg-transparent"
                  }
                >
                  <TableCell className="max-w-44 truncate font-mono text-xs">
                    {r.id}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.gpu ?? "CPU"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.state === "running" ? (
                      <StatusDot state="busy" label="Running" />
                    ) : r.state === "cooldown" ? (
                      <span className="inline-flex items-center gap-0">
                        <StatusDot state="idle" label="Cooldown" />
                        {r.deadline !== null && (
                          <Countdown deadline={r.deadline} />
                        )}
                      </span>
                    ) : (
                      <StatusDot state="idle" label="Terminated" />
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Uptime row={r} />
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {r.attached?.session ? (
                      <Link
                        href={`/repo/${owner}/${name}/sessions/${r.attached.session}`}
                        className="hover:text-foreground hover:underline"
                      >
                        session {r.attached.session}
                        {prBySession.has(r.attached.session)
                          ? ` · PR #${prBySession.get(r.attached.session)}`
                          : ""}
                      </Link>
                    ) : r.attached?.run ? (
                      <Link
                        href={`/repo/${owner}/${name}/reviews/${r.attached.run}`}
                        className="hover:text-foreground hover:underline"
                      >
                        run {r.attached.run}
                      </Link>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {gpuS === null ? <span className="text-faint">—</span> : gpuS}
                  </TableCell>
                  <TableCell className="text-right">
                    {terminated ? (
                      <span className="text-xs text-faint">—</span>
                    ) : (
                      <span className="inline-flex gap-1.5">
                        {r.state === "cooldown" && (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => act(r.id, "extend")}
                          >
                            Keep warm
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          className="text-bad"
                          onClick={() => act(r.id, "stop")}
                        >
                          Stop
                        </Button>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow className="border-border-soft hover:bg-transparent">
                <TableCell colSpan={7} className="py-6 text-center text-xs text-faint">
                  no sandboxes
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {feed && feed.events.length > 0 && (
        <div className="pt-3">
          <p className="text-[11px] text-faint">Activity — {feed.sandbox}</p>
          <div className="mt-1.5">
            {feed.events.map((e, i) => (
              <div
                key={i}
                className="ml-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-l border-border-soft py-1 pl-2.5"
              >
                <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-faint">
                  {fmtTime(e.t)}
                </span>
                <code className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
                  $ {String(e.detail.cmd ?? "")}
                </code>
                <span className="font-mono text-[10px] text-faint">
                  exit {String(e.detail.exit ?? "—")}
                </span>
              </div>
            ))}
            <div className="ml-1 flex items-baseline gap-2.5 border-l border-border-soft py-1 pl-2.5">
              <span className="w-14 shrink-0 font-mono text-[10px] text-faint">
                now
              </span>
              <span className="text-[11px] text-faint">
                session {feed.session} holds this sandbox — TTL resets on exec ·
                network blocked
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
