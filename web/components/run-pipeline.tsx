import {
  Activity,
  Box,
  Check,
  CircleDot,
  Clock3,
  Scale,
  Search,
  type LucideIcon,
} from "lucide-react";
import { STATUS_CHIPS } from "@/lib/phases";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/lib/types";

const icons: Record<RunStatus, LucideIcon> = {
  queued: Clock3,
  provisioning: Box,
  ready: CircleDot,
  measuring: Activity,
  verdict: Scale,
  investigating: Search,
  done: Check,
};

export function RunPipeline({ status }: { status: RunStatus }) {
  const currentIndex = Math.max(
    0,
    STATUS_CHIPS.findIndex((stage) => stage.status === status),
  );
  const progress = (currentIndex / (STATUS_CHIPS.length - 1)) * 100;
  const done = status === "done";
  const current = STATUS_CHIPS[currentIndex];

  return (
    <section
      aria-label="Review pipeline"
      className="rounded-xl border border-border-soft bg-card px-5 py-4"
    >
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">Review pipeline</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {done ? "Review complete" : `Currently ${current.label.toLowerCase()}`}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium",
            done
              ? "border-ok/35 bg-ok/10 text-ok"
              : "border-live/35 bg-live/10 text-live",
          )}
        >
          <i
            className={cn(
              "size-1.5 rounded-full",
              done ? "bg-ok" : "animate-pulse bg-live",
            )}
            aria-hidden
          />
          {current.label}
        </span>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="relative min-w-[760px] px-2">
          <div
            className="absolute top-5 right-[7.15%] left-[7.15%] h-px bg-border"
            aria-hidden
          >
            <div
              className={cn(
                "h-full transition-[width] duration-700 ease-out",
                done ? "bg-ok" : "bg-foreground/70",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>

          <ol className="relative z-10 grid grid-cols-7">
            {STATUS_CHIPS.map((stage, index) => {
              const active = index === currentIndex;
              const complete = index < currentIndex || (done && active);
              const upcoming = index > currentIndex;
              const Icon = icons[stage.status];

              return (
                <li
                  key={stage.status}
                  aria-current={active ? "step" : undefined}
                  className="flex flex-col items-center px-1 text-center"
                >
                  <span className="relative grid size-10 place-items-center">
                    {active && !done ? (
                      <span
                        className="absolute inset-0 animate-ping rounded-full border border-live/45 [animation-duration:1.8s]"
                        aria-hidden
                      />
                    ) : null}
                    <span
                      className={cn(
                        "relative grid size-9 place-items-center rounded-full border bg-card transition-colors duration-300",
                        complete && "border-foreground bg-foreground text-background",
                        active && !done && "border-live text-live shadow-[0_0_0_4px_rgb(106_175_255/0.1)]",
                        active && done && "border-ok bg-ok text-background",
                        upcoming && "border-border text-faint",
                      )}
                    >
                      {complete ? (
                        <Check className="size-4" strokeWidth={2.5} />
                      ) : (
                        <Icon
                          className={cn("size-4", active && "animate-pulse")}
                          strokeWidth={2}
                        />
                      )}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "mt-2 text-xs font-medium transition-colors",
                      complete && "text-foreground",
                      active && !done && "text-live",
                      active && done && "text-ok",
                      upcoming && "text-faint",
                    )}
                  >
                    {stage.label}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
