import Link from "next/link";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <Activity
      aria-hidden
      strokeWidth={2.25}
      className={cn("size-5 shrink-0 text-muted-foreground", className)}
    />
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="inferval home"
      className={cn(
        "inline-flex items-center gap-2 text-base font-semibold tracking-[-0.025em] text-foreground",
        className,
      )}
    >
      <BrandMark />
      <span>inferval</span>
    </Link>
  );
}
