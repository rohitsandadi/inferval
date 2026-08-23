"use client";

// New eval dialog (wireframe screen 6): a named scenario plus the thresholds
// it must hold. Local-only for now — the caller keeps the created eval in
// page state; there is no persistence endpoint yet.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EvalSpec, RepoInfo } from "@/lib/types";

const METRICS = [
  "tokens_per_s",
  "latency_ms_p95",
  "latency_ms_median",
  "peak_vram_mb",
] as const;

const GPUS = ["A10G", "L4", "A100", "H100"] as const;

interface CheckRow {
  metric: string;
  threshold: string;
}

function parseAbsolute(raw: string): Record<string, string> | undefined {
  const m = raw.trim().match(/^(\w+)\s*(<=?|>=?)\s*(\S+)$/);
  if (!m) return undefined;
  return { [m[1]]: `${m[2]}${m[3]}` };
}

// Gap-driven entry (wireframe-v3 screen 6): the dialog opens prefilled from a
// triage annotation's draft; the sub-line carries the provenance.
export interface EvalPrefill {
  name?: string;
  cmd?: string;
  checks?: Record<string, string>;
  est_gpu_seconds?: number;
  provenance?: string; // e.g. "Prefilled from gap a2 · PR #1 · drafted by session c_7f3a2b91"
}

export function NewEvalDialog({
  repo,
  open,
  onOpenChange,
  onCreate,
  prefill,
}: {
  repo: RepoInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (spec: EvalSpec) => void;
  prefill?: EvalPrefill | null;
}) {
  const [name, setName] = useState("");
  const [gpu, setGpu] = useState(repo.gpu);
  const [cmd, setCmd] = useState("");
  const [checks, setChecks] = useState<CheckRow[]>([
    { metric: "tokens_per_s", threshold: "-10%" },
    { metric: "latency_ms_p95", threshold: "+15%" },
  ]);
  const [absolute, setAbsolute] = useState("");

  useEffect(() => {
    if (!open) return;
    // Reset the draft when the controlled dialog opens with a new prefill.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(prefill?.name ?? "");
    setGpu(repo.gpu);
    setCmd(prefill?.cmd ?? "");
    setChecks(
      prefill?.checks && Object.keys(prefill.checks).length > 0
        ? Object.entries(prefill.checks).map(([metric, threshold]) => ({
            metric,
            threshold,
          }))
        : [
            { metric: "tokens_per_s", threshold: "-10%" },
            { metric: "latency_ms_p95", threshold: "+15%" },
          ],
    );
    setAbsolute("");
  }, [open, repo.gpu, prefill]);

  const canCreate =
    name.trim() !== "" &&
    cmd.trim() !== "" &&
    checks.length > 0 &&
    checks.every((c) => c.threshold.trim() !== "");

  const create = () => {
    onCreate({
      name: name.trim(),
      cmd: cmd.trim(),
      checks: Object.fromEntries(
        checks.map((c) => [c.metric, c.threshold.trim()]),
      ),
      absolute: parseAbsolute(absolute),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New eval</DialogTitle>
          <DialogDescription>
            {prefill?.provenance ??
              "A named scenario plus the thresholds it must hold."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ne-name" className="text-[11px] text-muted-foreground">
              Name
            </Label>
            <Input
              id="ne-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="generate_batch8"
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ne-gpu" className="text-[11px] text-muted-foreground">
              GPU
            </Label>
            <Select value={gpu} onValueChange={(v) => setGpu(v as string)}>
              <SelectTrigger id="ne-gpu" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GPUS.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="ne-cmd" className="text-[11px] text-muted-foreground">
              Command
            </Label>
            <Input
              id="ne-cmd"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder="bench.py --eval generate_batch8 --tokens 128 --batch 8 --out {out}"
              className="h-8 font-mono text-xs"
            />
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Checks</Label>
            <div className="rounded-md border border-border">
              {checks.map((row, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 border-b border-border-soft px-2 py-1.5"
                >
                  <Select
                    value={row.metric}
                    onValueChange={(v) =>
                      setChecks((cs) =>
                        cs.map((c, j) =>
                          j === i ? { ...c, metric: v as string } : c,
                        ),
                      )
                    }
                  >
                    <SelectTrigger size="sm" className="h-7 flex-1 font-mono text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METRICS.map((m) => (
                        <SelectItem key={m} value={m} className="font-mono text-xs">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={row.threshold}
                    onChange={(e) =>
                      setChecks((cs) =>
                        cs.map((c, j) =>
                          j === i ? { ...c, threshold: e.target.value } : c,
                        ),
                      )
                    }
                    placeholder="-10%"
                    className="h-7 w-20 font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    aria-label="Remove check"
                    onClick={() =>
                      setChecks((cs) => cs.filter((_, j) => j !== i))
                    }
                    className="text-faint hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setChecks((cs) => [
                    ...cs,
                    { metric: "peak_vram_mb", threshold: "+8%" },
                  ])
                }
                className="w-full px-2.5 py-1.5 text-left font-mono text-[11px] text-faint hover:text-foreground"
              >
                + Add check
              </button>
            </div>
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="ne-abs" className="text-[11px] text-muted-foreground">
              Absolute limit (optional)
            </Label>
            <Input
              id="ne-abs"
              value={absolute}
              onChange={(e) => setAbsolute(e.target.value)}
              placeholder="latency_ms_p95 < 3000"
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>

        {prefill?.est_gpu_seconds !== undefined && (
          <p className="font-mono text-[10px] text-faint">
            est_gpu_seconds {prefill.est_gpu_seconds} · adds ~$
            {Math.max(0.01, prefill.est_gpu_seconds * (1.1 / 3600)).toFixed(2)}{" "}
            per review
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canCreate} onClick={create}>
            Create eval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
