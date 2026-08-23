"use client";

// Proposals tab (wireframe screen 9): one card per probe proposal. Approve /
// Deny are live while a proposal is pending; executed ones render settled.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot, type DotState } from "@/components/status-dot";
import { decideProposal } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Proposal } from "@/lib/types";

// A10G on-demand ballpark; cost display only.
const GPU_USD_PER_S = 1.1 / 3600;
const PROPOSAL_TTL_S = 180;

export type ProposalWithTime = Proposal & { proposed_t?: string };

const statusDot: Record<Proposal["status"], { state: DotState; label: string }> =
  {
    proposed: { state: "busy", label: "Awaiting approval" },
    approved: { state: "busy", label: "Approved" },
    done: { state: "ok", label: "Done" },
    denied: { state: "idle", label: "Denied" },
    expired: { state: "idle", label: "Expired" },
  };

function Countdown({ from }: { from: string }) {
  const [left, setLeft] = useState(() =>
    Math.max(
      0,
      PROPOSAL_TTL_S - Math.floor((Date.now() - new Date(from).getTime()) / 1000),
    ),
  );
  useEffect(() => {
    const t = setInterval(
      () =>
        setLeft(
          Math.max(
            0,
            PROPOSAL_TTL_S -
              Math.floor((Date.now() - new Date(from).getTime()) / 1000),
          ),
        ),
      1000,
    );
    return () => clearInterval(t);
  }, [from]);
  if (left <= 0) return null;
  return (
    <span className="text-[11px] text-faint">
      expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

function ProposalCard({
  runId,
  proposal,
}: {
  runId: string;
  proposal: ProposalWithTime;
}) {
  const [status, setStatus] = useState<Proposal["status"]>(proposal.status);
  const [busy, setBusy] = useState(false);

  const decide = async (decision: "approved" | "denied") => {
    setBusy(true);
    try {
      await decideProposal(runId, proposal.id, decision);
      setStatus(decision); // optimistic in mock mode; real mode confirms via events
    } finally {
      setBusy(false);
    }
  };

  const dot = statusDot[status];
  const pending = status === "proposed";
  const est = proposal.est_gpu_seconds;

  return (
    <div
      className={cn(
        "rounded-xl border p-3.5",
        pending ? "border-border" : "border-border-soft",
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-xs text-faint">{proposal.id}</span>
        <span className="font-mono text-xs">{proposal.kind}</span>
        <StatusDot state={dot.state} label={dot.label} className="text-xs" />
        <span className="ml-auto font-mono text-[11px] text-faint">
          {pending ? "est " : ""}
          {est} GPU-s · {pending ? "~" : ""}${(est * GPU_USD_PER_S).toFixed(2)}
        </span>
      </div>
      <p className="mt-2 max-w-[70ch] text-xs text-muted-foreground">
        {proposal.reason}
      </p>
      {Object.keys(proposal.params).length > 0 && (
        <p className="mt-2 font-mono text-[10.5px] text-faint">
          {JSON.stringify(proposal.params)}
        </p>
      )}
      {pending && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5">
          {proposal.proposed_t ? <Countdown from={proposal.proposed_t} /> : <span />}
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => decide("denied")}
              className="text-bad"
            >
              Deny
            </Button>
            <Button size="sm" disabled={busy} onClick={() => decide("approved")}>
              Approve
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

export function ProposalZone({
  runId,
  proposals,
}: {
  runId: string;
  proposals: ProposalWithTime[];
}) {
  if (proposals.length === 0)
    return <p className="text-xs text-faint">no proposals</p>;
  return (
    <div className="space-y-3">
      {proposals.map((p) => (
        // status in the key: replayed approval events remount with fresh state
        <ProposalCard key={`${p.id}-${p.status}`} runId={runId} proposal={p} />
      ))}
    </div>
  );
}
