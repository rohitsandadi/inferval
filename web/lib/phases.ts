// Groups the event feed under the six-verb lifecycle and derives the status
// chip. Sequential state machine: a marker kind advances the phase; unknown
// kinds stay in the current phase (the kind enum is open).

import type { InfervalEvent, RunStatus } from "@/lib/types";

export const PHASES = [
  "Submit",
  "Plan",
  "Measure",
  "Verdict",
  "Investigate",
  "Verify",
] as const;

export type Phase = (typeof PHASES)[number];

export const STATUS_CHIPS: { status: RunStatus; label: string }[] = [
  { status: "queued", label: "Queued" },
  { status: "provisioning", label: "Provisioning" },
  { status: "ready", label: "Ready" },
  { status: "measuring", label: "Measuring" },
  { status: "verdict", label: "Verdict" },
  { status: "investigating", label: "Investigating" },
  { status: "done", label: "Done" },
];

const AGENT_REASONING_KINDS = new Set([
  "plan",
  "observation",
  "hypothesis",
  "probe_proposed",
  "probe_launched",
  "proposal_approved",
  "proposal_denied",
  "conclusion",
]);

export function isAgentReasoning(e: InfervalEvent): boolean {
  return AGENT_REASONING_KINDS.has(e.kind) && e.tier !== "system";
}

export interface PhaseGroup {
  phase: Phase;
  events: { index: number; event: InfervalEvent }[];
}

export function groupByPhase(events: InfervalEvent[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  let phase: Phase = "Submit";
  let sawVerdict = false;

  const push = (index: number, event: InfervalEvent) => {
    const last = groups[groups.length - 1];
    if (last && last.phase === phase) last.events.push({ index, event });
    else groups.push({ phase, events: [{ index, event }] });
  };

  events.forEach((e, i) => {
    if (e.kind === "plan") phase = "Plan";
    else if (
      !sawVerdict &&
      (e.kind === "bench_block_done" ||
        e.kind === "preflight_ok" ||
        e.kind === "preflight_failed" ||
        (e.kind === "status" &&
          ["provisioning", "ready"].includes(String(e.detail.status))))
    )
      phase = "Measure";
    else if (e.kind === "verdict") {
      phase = "Verdict";
      sawVerdict = true;
    } else if (sawVerdict && (e.tier === "agent" || e.tier === "human"))
      phase = "Investigate";
    else if (e.kind === "report_ready") phase = "Verify";
    push(i, e);
  });
  return groups;
}

// The events feed is the status source of truth: latest event wins.
export function statusFromEvents(events: InfervalEvent[]): RunStatus {
  let status: RunStatus = "queued";
  let sawVerdict = false;
  for (const e of events) {
    if (e.kind === "status") {
      const s = String(e.detail.status);
      if (s === "provisioning") status = "provisioning";
      else if (s === "ready") status = "ready";
      else if (s === "done") status = "done";
    } else if (e.kind === "plan" || e.kind === "plan_fallback") {
      status = "provisioning";
    } else if (e.kind === "sandbox_up" || e.kind === "revisions_ready") {
      status = "ready";
    } else if (e.kind === "bench_block_done" || e.kind === "preflight_ok") {
      if (!sawVerdict) status = "measuring";
    } else if (e.kind === "verdict") {
      status = "verdict";
      sawVerdict = true;
    } else if (e.kind === "report_ready" || e.kind === "terminated") {
      status = "done";
    } else if (sawVerdict && (e.tier === "agent" || e.tier === "human")) {
      status = "investigating";
    }
  }
  return status;
}
