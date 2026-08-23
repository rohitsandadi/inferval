import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AppTopbar({
  children,
  actions,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex min-h-16 items-center justify-between gap-4 border-b border-border-soft bg-sidebar px-6 py-3 max-md:px-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-center">{children}</div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2.5">{actions}</div>
      ) : null}
    </header>
  );
}
