"use client";

// The session pane (wireframe-v3 screens 1–3): a background-worker surface.
// "Review this PR" opens one worker turn; its artifacts stream in as cards —
// review_requested, triage, collapsed thinking, env_decision, sandbox
// act-chips, the proposed scoped eval (Keep in suite), test results,
// review_submitted, errors. Unknown kinds render as plain chips; nothing
// breaks.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusDot, verdictDot } from "@/components/status-dot";
import { CoverageChip, RiskTag } from "@/components/diff-view";
import { useCreateEvalMutation } from "@/lib/queries";
import { fmtClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InfervalEvent, Annotation, EvalDraft, VerdictKind } from "@/lib/types";

const ENV_OPTIONS = ["none", "cpu", "T4", "A10G", "A100"];

function hm(t: string): string {
  return new Date(t).toISOString().slice(11, 16);
}
function hms(t: string): string {
  return new Date(t).toISOString().slice(11, 19);
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

// ---- small blocks ----------------------------------------------------------

function ActChip({
  k,
  children,
}: {
  k: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 overflow-hidden rounded-md border border-border-soft bg-surface px-2 py-1 font-mono text-[12px] text-muted-foreground">
      <span className="shrink-0 text-[11px] text-faint">{k}</span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {children}
      </span>
    </div>
  );
}

function CardShell({
  kind,
  time,
  children,
  emphasized = false,
}: {
  kind: string;
  time?: string;
  children: React.ReactNode;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-2.5 text-[13px]",
        emphasized ? "border-border" : "border-border-soft",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] tracking-wide text-faint">
          {kind}
        </span>
        {time && (
          <span className="font-mono text-[11px] text-faint">{time}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function coverageChips(a: Annotation) {
  if (a.coverage === "gap") return <CoverageChip label="gap" gap />;
  const evals = a.coverage as string[];
  if (evals.length > 1) return <CoverageChip label={`${evals.length} evals`} />;
  return <CoverageChip label={evals[0]} />;
}

function TriageCard({ e }: { e: InfervalEvent }) {
  const anns = (e.detail.annotations as Annotation[] | undefined) ?? [];
  return (
    <CardShell kind="triage" time={hms(e.t)}>
      <div className="mt-1 text-[13px]">{str(e.detail.summary)}</div>
      {anns.map((a) => (
        <div key={a.id} className="flex flex-wrap items-baseline gap-1.5 py-0.5 text-[12px]">
          <span className="w-[18px] shrink-0 font-mono text-[11px] text-faint">
            {a.id}
          </span>
          <RiskTag risk={a.risk} />
          <span className="min-w-0 text-muted-foreground">{a.note}</span>
          {coverageChips(a)}
        </div>
      ))}
    </CardShell>
  );
}

function EnvDecisionCard({ e }: { e: InfervalEvent }) {
  const kind = str(e.detail.kind);
  return (
    <CardShell kind="env_decision" time={hms(e.t)}>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {ENV_OPTIONS.map((o) => (
          <span
            key={o}
            className={cn(
              "rounded-md border px-2 py-0.5 font-mono text-[12px]",
              o === kind
                ? "border-foreground text-foreground"
                : "border-border-soft text-faint",
            )}
          >
            {o}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-muted-foreground">
        {str(e.detail.reason)}
      </p>
      {e.detail.est_cost !== undefined && (
        <p className="mt-1 font-mono text-[11px] text-faint">
          est {str(e.detail.est_cost)}
        </p>
      )}
    </CardShell>
  );
}

// The worker's one scoped eval for this PR. It runs with the review either
// way; "Keep in suite" persists it to the repo's eval store (origin "pr:<N>").
// Not keeping is the default, so there is no deny action.
function EvalDraftCard({
  e,
  repoName,
  prNumber,
}: {
  e: InfervalEvent;
  repoName: string;
  prNumber: number | null;
}) {
  const d = e.detail as unknown as EvalDraft;
  const keep = useCreateEvalMutation(repoName);
  const kept = keep.isSuccess;
  return (
    <CardShell
      kind="eval_draft · proposed for this PR"
      time={`${d.id} · from ${d.origin}`}
      emphasized={!kept}
    >
      <div className="mt-1 font-mono text-[13px]">{d.name}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
        {d.cmd}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {Object.entries(d.checks ?? {}).map(([m, t]) => (
          <span
            key={m}
            className="rounded-full border border-border bg-surface px-1.5 font-mono text-[11px] leading-4 text-muted-foreground"
          >
            {m} ≤ {t}
          </span>
        ))}
        <span className="rounded-full border border-border bg-surface px-1.5 font-mono text-[11px] leading-4 text-muted-foreground">
          {d.est_gpu_seconds} GPU-s
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-soft pt-2">
        <span className="text-[12px] text-faint">
          {kept ? "in the suite" : "runs with this review; expires unless kept"}
        </span>
        {kept ? (
          <span className="font-mono text-[12px] text-muted-foreground">
            kept
          </span>
        ) : (
          <Button
            size="xs"
            disabled={keep.isPending}
            onClick={() =>
              keep.mutate({
                name: d.name,
                cmd: d.cmd,
                checks: d.checks,
                origin: prNumber != null ? `pr:${prNumber}` : undefined,
              })
            }
          >
            Keep in suite
          </Button>
        )}
      </div>
      {keep.error && (
        <p className="mt-1 break-words text-[12px] text-bad">
          {keep.error.message}
        </p>
      )}
    </CardShell>
  );
}

function SandboxProposalCard({
  e,
  status,
}: {
  e: InfervalEvent;
  status: string;
}) {
  const dot =
    status === "proposed"
      ? ({ state: "busy", label: "Awaiting approval" } as const)
      : status === "denied"
        ? ({ state: "idle", label: "Denied" } as const)
        : status === "expired"
          ? ({ state: "idle", label: "Expired" } as const)
          : ({ state: "busy", label: "Approved" } as const);
  return (
    <CardShell kind={`sandbox_proposed · ${str(e.detail.id)}`} time={hms(e.t)}>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-mono text-[13px]">{str(e.detail.gpu)}</span>
        <StatusDot state={dot.state} label={dot.label} className="text-[12px]" />
        <span className="ml-auto font-mono text-[11px] text-faint">
          {str(e.detail.est_cost)}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {str(e.detail.reason)}
      </p>
    </CardShell>
  );
}

function ReviewSubmittedCard({
  e,
  linked,
  reviewHref,
}: {
  e: InfervalEvent;
  linked: { verdict: VerdictKind | null; status: string; cost_usd: number | null } | null;
  reviewHref: string;
}) {
  const run = str(e.detail.run);
  const dot = linked
    ? verdictDot(linked.verdict, linked.status)
    : { state: "busy" as const, label: "Running" };
  const evals = e.detail.evals;
  const scopedEval = str(e.detail.scoped_eval);
  return (
    <CardShell kind="review_submitted" time={hms(e.t)}>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-mono text-[13px]">{run}</span>
        <StatusDot state={dot.state} label={dot.label} className="text-[12px]" />
      </div>
      <div className="mt-1 font-mono text-[11px] text-faint">
        {str(e.detail.head)} → {str(e.detail.base)} ·{" "}
        {Array.isArray(evals) ? `${evals.length} evals` : str(evals)}
        {linked?.cost_usd != null ? ` · $${linked.cost_usd.toFixed(2)}` : ""}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-soft pt-2">
        <span className="text-[12px] text-faint">
          {scopedEval ? (
            <>
              + scoped eval <span className="font-mono">{scopedEval}</span>
            </>
          ) : (
            "verdict is policy, not the session"
          )}
        </span>
        <Button
          size="xs"
          variant="outline"
          nativeButton={false}
          render={<Link href={reviewHref} />}
        >
          Open review
        </Button>
      </div>
    </CardShell>
  );
}

// ---- feed assembly ---------------------------------------------------------

type Block =
  | { type: "event"; e: InfervalEvent }
  | { type: "thinking"; events: InfervalEvent[] };

function toBlocks(events: InfervalEvent[]): Block[] {
  const blocks: Block[] = [];
  for (const e of events) {
    if (e.kind === "turn_done") continue;
    if (e.kind === "sandbox_denied" || e.kind === "sandbox_expired") continue; // folded into the proposal card
    if (e.kind === "thinking") {
      const last = blocks[blocks.length - 1];
      if (last?.type === "thinking") last.events.push(e);
      else blocks.push({ type: "thinking", events: [e] });
    } else {
      blocks.push({ type: "event", e });
    }
  }
  return blocks;
}

function ThinkingBlock({ events }: { events: InfervalEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? events : events.slice(0, 2);
  return (
    <div className="flex flex-col gap-0.5 pl-0.5">
      {shown.map((e, i) => (
        <span key={i} className="text-[12px] text-faint">
          ▸ {str(e.detail.text)}
        </span>
      ))}
      {events.length > 2 && (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="self-start text-[12px] text-faint hover:text-foreground"
        >
          {expanded ? "collapse" : `▸ ${events.length - 2} more`}
        </button>
      )}
    </div>
  );
}

function WorkingIndicator({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, (now - new Date(since).getTime()) / 1000);
  return (
    <div className="flex items-center gap-2 pl-0.5">
      <StatusDot state="busy" label="Turn running" className="text-[12px]" />
      <span className="font-mono text-[12px] tabular-nums text-faint">
        {fmtClock(s)}
      </span>
    </div>
  );
}

export function SessionPane({
  events,
  owner,
  name,
  repoName,
  pr,
  branch,
  linkedRuns,
  working,
  workingSince,
  onReview,
  reviewPending,
}: {
  events: InfervalEvent[];
  owner: string;
  name: string;
  repoName: string;
  pr: { number: number; title: string } | null;
  branch: string | null;
  // review_submitted run id -> its fetched state (null until loaded)
  linkedRuns: Record<
    string,
    { verdict: VerdictKind | null; status: string; cost_usd: number | null } | null
  >;
  working: boolean;
  workingSince: string | null;
  onReview: () => void;
  reviewPending: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const blocks = useMemo(() => toBlocks(events), [events]);

  const proposalStatus = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of events) {
      const id = str(e.detail.id);
      if (e.kind === "sandbox_proposed") m[id] = str(e.detail.status) || "proposed";
      else if (e.kind === "sandbox_denied") m[id] = "denied";
      else if (e.kind === "sandbox_expired") m[id] = "expired";
    }
    return m;
  }, [events]);

  // keep the feed pinned to the newest card (feed-local scroll only)
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, working]);

  if (events.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-5 text-center">
        {pr ? (
          <div>
            <p className="text-[14px] font-medium">{pr.title}</p>
            <p className="mt-0.5 font-mono text-[12px] text-faint">
              PR #{pr.number}
            </p>
          </div>
        ) : branch ? (
          <p className="font-mono text-[13px]">{branch}</p>
        ) : (
          <p className="text-[12px] text-faint">
            no PR or branch attached — nothing to review
          </p>
        )}
        {(pr || branch) && (
          <>
            <Button onClick={onReview} disabled={reviewPending || working}>
              {reviewPending || working
                ? "Review running"
                : pr
                  ? "Review this PR"
                  : "Review this branch"}
            </Button>
            <p className="max-w-[36ch] text-[12px] text-muted-foreground">
              Triages the diff, checks eval coverage, may propose one scoped
              eval, submits the review.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5"
      >
        {blocks.map((b, i) => {
          if (b.type === "thinking")
            return <ThinkingBlock key={i} events={b.events} />;
          const e = b.e;
          switch (e.kind) {
            case "user_message":
              return (
                <div
                  key={i}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px]"
                >
                  <div className="mb-0.5 font-mono text-[11px] text-faint">
                    you · {hm(e.t)}
                  </div>
                  {str(e.detail.text)}
                </div>
              );
            case "agent_message":
              return (
                <p key={i} className="px-0.5 text-[13px] text-muted-foreground">
                  {str(e.detail.text)}
                </p>
              );
            case "review_requested":
              return (
                <ActChip key={i} k="review_requested">
                  PR #{str(e.detail.pr) || str(pr?.number)} · turn{" "}
                  {str(e.detail.turn)}
                </ActChip>
              );
            case "triage":
              return <TriageCard key={i} e={e} />;
            case "env_decision":
              return <EnvDecisionCard key={i} e={e} />;
            case "eval_draft":
              return (
                <EvalDraftCard
                  key={i}
                  e={e}
                  repoName={repoName}
                  prNumber={pr?.number ?? null}
                />
              );
            case "sandbox_proposed":
              return (
                <SandboxProposalCard
                  key={i}
                  e={e}
                  status={proposalStatus[str(e.detail.id)] ?? "proposed"}
                />
              );
            case "sandbox_created":
              return (
                <ActChip key={i} k="sandbox_created">
                  {str(e.detail.sandbox_id)} · {str(e.detail.gpu)}
                </ActChip>
              );
            case "sandbox_exec":
              return (
                <div key={i} className="flex flex-col gap-1">
                  <ActChip k="sandbox_exec">$ {str(e.detail.cmd)}</ActChip>
                  <ActChip k="→">
                    exit {str(e.detail.exit)}
                    {e.detail.tail ? ` · ${str(e.detail.tail)}` : ""}
                  </ActChip>
                </div>
              );
            case "sandbox_released":
              return (
                <ActChip key={i} k="sandbox_released">
                  {str(e.detail.sandbox_id)} · cooldown{" "}
                  {fmtClock(Number(e.detail.cooldown_s ?? 0))}
                </ActChip>
              );
            case "test_result":
              return (
                <ActChip key={i} k="test_result">
                  {str(e.detail.eval)} · {str(e.detail.headline)}
                </ActChip>
              );
            case "review_submitted": {
              const run = str(e.detail.run);
              return (
                <ReviewSubmittedCard
                  key={i}
                  e={e}
                  linked={linkedRuns[run] ?? null}
                  reviewHref={`/repo/${owner}/${name}/reviews/${run}`}
                />
              );
            }
            case "error":
              return (
                <div key={i} className="flex items-baseline gap-2 px-0.5">
                  <StatusDot state="bad" label="Error" className="text-[12px]" />
                  <span className="min-w-0 break-words font-mono text-[12px] text-muted-foreground">
                    {str(e.detail.error)}
                  </span>
                </div>
              );
            default:
              return (
                <ActChip key={i} k={e.kind}>
                  {JSON.stringify(e.detail)}
                </ActChip>
              );
          }
        })}
        {working && workingSince && <WorkingIndicator since={workingSince} />}
      </div>
    </div>
  );
}
