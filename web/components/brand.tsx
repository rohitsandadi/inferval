import Link from "next/link";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-muted text-foreground shadow-[inset_0_1px_rgb(255_255_255/0.06)]",
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none">
        <path
          d="M3.75 12h4.1l2.35-5.25 3.45 10.5L16.2 12h4.05"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="inferval home"
      className={cn(
        "inline-flex items-center gap-2.5 text-base font-semibold tracking-[-0.025em] text-foreground",
        className,
      )}
    >
      <BrandMark />
      <span>inferval</span>
    </Link>
  );
}
