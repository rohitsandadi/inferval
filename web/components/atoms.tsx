import { cn } from "@/lib/utils";
import { fmtDelta } from "@/lib/format";

export type DeltaTone = "bad" | "warn" | "good" | "neutral";

// Delta numbers are one of the two places red/green ink is allowed.
export function Delta({
  pct,
  tone = "neutral",
  className,
}: {
  pct: number | null | undefined;
  tone?: DeltaTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        tone === "bad" && "text-bad",
        tone === "warn" && "text-note",
        tone === "good" && "text-ok",
        tone === "neutral" && "text-foreground/80",
        pct === null || pct === undefined ? "text-faint" : undefined,
        className,
      )}
    >
      {fmtDelta(pct)}
    </span>
  );
}
