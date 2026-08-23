// Status = colored dot + plain sentence-case word (Vercel-deployments style).
// The ONLY place red/green ink is allowed besides delta numbers.

import { cn } from "@/lib/utils";
import { fmtDelta } from "@/lib/format";
import type { BranchInfo, VerdictKind } from "@/lib/types";

export type DotState = "ok" | "bad" | "busy" | "idle";

const dotColor: Record<DotState, string> = {
  ok: "bg-ok",
  bad: "bg-bad",
  busy: "bg-live",
  idle: "bg-faint",
};

export function StatusDot({
  state,
  label,
  className,
}: {
  state: DotState;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <i
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          dotColor[state],
        )}
        aria-hidden
      />
      <span className="text-foreground/90">{label}</span>
    </span>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// pass -> ok "Pass"; regression/invalid -> bad; null with an in-flight status
// -> busy with the capitalized status; null otherwise -> idle "Unverified".
export function verdictDot(
  verdict: VerdictKind | null,
  status?: string,
): { state: DotState; label: string } {
  if (verdict === "pass") return { state: "ok", label: "Pass" };
  if (verdict === "regression") return { state: "bad", label: "Regression" };
  if (verdict === "invalid") return { state: "bad", label: "Invalid" };
  if (status && status !== "done")
    return { state: "busy", label: capitalize(status) };
  return { state: "idle", label: "Unverified" };
}

// Branch state vs base, delta folded into the label ("Regression -33.0%").
export function branchStateDot(
  b: BranchInfo,
  withDelta = true,
): {
  state: DotState;
  label: string;
} {
  const delta = withDelta ? b.last_review?.tokens_per_s_delta_pct : undefined;
  const suffix =
    delta === null || delta === undefined ? "" : ` ${fmtDelta(delta)}`;
  if (b.state === "verified") return { state: "ok", label: `Verified${suffix}` };
  if (b.state === "regression")
    return { state: "bad", label: `Regression${suffix}` };
  if (b.state === "running")
    return { state: "busy", label: capitalize(b.last_review?.status ?? "running") };
  return { state: "idle", label: "Unverified" };
}
