"use client";

// Annotated unified-diff renderer (wireframe-v3 screens 1–2). Risk-typed
// gutter bars where triage annotations overlap; click opens the annotation
// popover (note, coverage-or-gap, Draft eval); after a review, verdict chips
// land on the same lines. Diff add/del tints are the one approved exception
// to the red/green rule.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DiffFile, DiffLine } from "@/lib/diff";
import type { Annotation } from "@/lib/types";

export type RiskKind = Annotation["risk"];

const riskBar: Record<string, string> = {
  perf: "bg-note",
  correctness: "bg-[#52A8FF]",
  memory: "bg-[#A78BFA]",
};

const riskTag: Record<string, string> = {
  perf: "border-note/40 text-note",
  correctness: "border-live/45 text-[#52A8FF]",
  memory: "border-[#A78BFA]/40 text-[#A78BFA]",
};

const riskShort: Record<string, string> = {
  perf: "perf",
  correctness: "corr",
  memory: "mem",
  none: "note",
};

export function RiskTag({ risk }: { risk: RiskKind }) {
  return (
    <span
      className={cn(
        "rounded-[4px] border px-1.5 font-mono text-[9px] leading-4",
        riskTag[risk] ?? "border-border text-muted-foreground",
      )}
    >
      {riskShort[risk] ?? risk}
    </span>
  );
}

export function CoverageChip({
  label,
  gap = false,
}: {
  label: string;
  gap?: boolean;
}) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full border px-1.5 font-mono text-[9.5px] leading-4",
        gap ? "border-note/40 text-note" : "border-border text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

// A verdict result pinned onto the diff after a specific new-side line.
export interface VerdictChip {
  path: string;
  afterLine: number;
  tone: "bad" | "ok";
  text: string;
  sub?: string;
}

function ChipRow({ chip }: { chip: VerdictChip }) {
  return (
    <div
      className={cn(
        "ml-[88px] flex min-w-[520px] items-center gap-2 border-l-2 px-2.5 py-1 font-mono text-[10px] text-foreground",
        chip.tone === "bad"
          ? "border-bad bg-bad/5"
          : "border-ok bg-ok/5",
      )}
    >
      <i
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          chip.tone === "bad" ? "bg-bad" : "bg-ok",
        )}
        aria-hidden
      />
      <span>{chip.text}</span>
      {chip.sub && <span className="text-faint">· {chip.sub}</span>}
    </div>
  );
}

function annotationFor(
  line: DiffLine,
  path: string,
  annotations: Annotation[],
): Annotation | null {
  if (line.newNo === null) return null;
  return (
    annotations.find(
      (a) =>
        a.path === path &&
        line.newNo !== null &&
        line.newNo >= a.start_line &&
        line.newNo <= a.end_line,
    ) ?? null
  );
}

export function AnnotationPopover({
  annotation,
  onDraftEval,
  onClose,
  style,
}: {
  annotation: Annotation;
  onDraftEval?: (a: Annotation) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}) {
  const gap = annotation.coverage === "gap";
  return (
    <div
      className="absolute z-10 w-[268px] rounded-lg border border-border bg-surface p-3 text-[11px] shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
      style={style}
    >
      <div className="flex items-center gap-2">
        <RiskTag risk={annotation.risk} />
        <span className="font-mono text-[10px]">
          {annotation.id} · {annotation.path}{" "}
          {annotation.start_line === annotation.end_line
            ? annotation.start_line
            : `${annotation.start_line}–${annotation.end_line}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close annotation"
          className="ml-auto text-faint hover:text-foreground"
        >
          ×
        </button>
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
        {annotation.note}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-faint">Coverage</span>
        {gap ? (
          <CoverageChip label="gap" gap />
        ) : (
          (annotation.coverage as string[]).map((c) => (
            <CoverageChip key={c} label={c} />
          ))
        )}
      </div>
      {gap && onDraftEval && (
        <div className="mt-2.5 flex items-center justify-between border-t border-border-soft pt-2">
          <span className="text-[10px] text-faint">asks the session agent</span>
          <Button size="xs" variant="outline" onClick={() => onDraftEval(annotation)}>
            Draft eval
          </Button>
        </div>
      )}
    </div>
  );
}

export function DiffView({
  file,
  annotations,
  chips = [],
  onDraftEval,
}: {
  file: DiffFile;
  annotations: Annotation[];
  chips?: VerdictChip[];
  onDraftEval?: (a: Annotation) => void;
}) {
  const [open, setOpen] = useState<{ id: string; top: number } | null>(null);
  const openAnnotation = open
    ? (annotations.find((a) => a.id === open.id) ?? null)
    : null;

  const context = file.hunks[0]?.context ?? "";

  return (
    <div className="relative">
      <div className="overflow-x-auto rounded-md border border-border-soft">
        <div className="flex items-center justify-between gap-2.5 border-b border-border-soft bg-surface px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground">
          <span>{file.path}</span>
          <span className="text-faint">{context}</span>
        </div>
        <div className="min-w-[640px] font-mono text-[10.5px] leading-[1.75]">
          {file.hunks.map((h, hi) => (
            <div key={hi}>
              {h.lines.map((line, li) => {
                const ann =
                  line.kind === "hunk"
                    ? null
                    : annotationFor(line, file.path, annotations);
                const lineChips =
                  line.newNo === null
                    ? []
                    : chips.filter(
                        (c) =>
                          c.path === file.path && c.afterLine === line.newNo,
                      );
                return (
                  <div key={li}>
                    <div
                      onClick={
                        ann
                          ? (e) => {
                              // read before setState: React nulls currentTarget
                              const top =
                                (e.currentTarget as HTMLElement)?.offsetTop ?? 0;
                              setOpen((o) =>
                                o?.id === ann.id ? null : { id: ann.id, top },
                              );
                            }
                          : undefined
                      }
                      className={cn(
                        "grid grid-cols-[4px_34px_34px_16px_1fr]",
                        line.kind === "add" && "bg-ok/[0.055]",
                        line.kind === "del" && "bg-bad/[0.055]",
                        ann && "cursor-pointer",
                      )}
                    >
                      <span className={cn(ann && riskBar[ann.risk])} />
                      <span className="select-none pr-2 text-right text-[#3D3D3D]">
                        {line.oldNo ?? ""}
                      </span>
                      <span className="select-none pr-2 text-right text-[#3D3D3D]">
                        {line.newNo ?? ""}
                      </span>
                      <span
                        className={cn(
                          "text-center",
                          line.kind === "add" && "text-ok",
                          line.kind === "del" && "text-bad",
                          line.kind === "ctx" && "text-faint",
                        )}
                      >
                        {line.kind === "add"
                          ? "+"
                          : line.kind === "del"
                            ? "−"
                            : ""}
                      </span>
                      <span
                        className={cn(
                          "whitespace-pre pr-3",
                          line.kind === "add"
                            ? "text-foreground"
                            : line.kind === "hunk"
                              ? "text-[#52A8FF] opacity-65"
                              : "text-muted-foreground",
                        )}
                      >
                        {line.text}
                      </span>
                    </div>
                    {lineChips.map((c, ci) => (
                      <ChipRow key={ci} chip={c} />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {openAnnotation && (
        <AnnotationPopover
          annotation={openAnnotation}
          onDraftEval={onDraftEval}
          onClose={() => setOpen(null)}
          style={{ right: 8, top: Math.max(28, (open?.top ?? 0) - 20) }}
        />
      )}
    </div>
  );
}
