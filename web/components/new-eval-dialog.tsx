"use client";

// New eval dialog (wireframe screen 6): a named scenario plus the thresholds
// it must hold. The user only picks the scenario knobs (tokens/batch/repeats);
// the dialog composes the harness command itself — plumbing stays invisible.
// Create persists through the per-repo eval store (POST /api/repos/{repo}/evals);
// validation failures surface the server's message and keep the dialog open.

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
import { useCreateEvalMutation } from "@/lib/queries";
import type { EvalSpec, RepoInfo } from "@/lib/types";

const METRICS = [
  "tokens_per_s",
  "latency_ms_p95",
  "latency_ms_median",
  "peak_vram_mb",
] as const;

interface CheckRow {
  metric: string;
  threshold: string;
}

interface Knobs {
  tokens: string;
  batch: string;
  repeats: string;
}

const DEFAULT_KNOBS: Knobs = { tokens: "128", batch: "1", repeats: "5" };

function parseAbsolute(raw: string): Record<string, string> | undefined {
  const m = raw.trim().match(/^(\w+)\s*(<=?|>=?)\s*(\S+)$/);
  if (!m) return undefined;
  return { [m[1]]: `${m[2]}${m[3]}` };
}

// The harness's --eval is a label; behavior comes entirely from the knobs.
function composeCmd(name: string, knobs: Knobs): string {
  return (
    `python /harness/bench.py --src {src} --eval ${name} ` +
    `--tokens ${knobs.tokens} --batch ${knobs.batch} ` +
    `--repeats ${knobs.repeats} --out {out}`
  );
}

// Drafts arrive as full commands (the worker's scoped evals are harness-
// parameterized, so these flags always exist); missing flags keep defaults.
function knobsFromCmd(cmd: string | undefined): Knobs {
  const pick = (flag: string, fallback: string) =>
    cmd?.match(new RegExp(`--${flag}[ =](\\d+)`))?.[1] ?? fallback;
  return {
    tokens: pick("tokens", DEFAULT_KNOBS.tokens),
    batch: pick("batch", DEFAULT_KNOBS.batch),
    repeats: pick("repeats", DEFAULT_KNOBS.repeats),
  };
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
  onCreate?: (spec: EvalSpec) => void;
  prefill?: EvalPrefill | null;
}) {
  const [name, setName] = useState("");
  const [knobs, setKnobs] = useState<Knobs>(DEFAULT_KNOBS);
  const [checks, setChecks] = useState<CheckRow[]>([
    { metric: "tokens_per_s", threshold: "-10%" },
    { metric: "latency_ms_p95", threshold: "+15%" },
  ]);
  const [absolute, setAbsolute] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createMutation = useCreateEvalMutation(repo.name);

  useEffect(() => {
    if (!open) return;
    // Reset the draft when the controlled dialog opens with a new prefill.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(prefill?.name ?? "");
    setKnobs(knobsFromCmd(prefill?.cmd));
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
    setError(null);
  }, [open, prefill]);

  const knobsValid = (["tokens", "batch", "repeats"] as const).every((k) => {
    const n = Number(knobs[k]);
    return Number.isInteger(n) && n >= 1;
  });

  const canCreate =
    name.trim() !== "" &&
    knobsValid &&
    checks.length > 0 &&
    checks.every((c) => c.threshold.trim() !== "");

  const create = async () => {
    const spec: EvalSpec = {
      name: name.trim(),
      cmd: composeCmd(name.trim(), knobs),
      checks: Object.fromEntries(
        checks.map((c) => [c.metric, c.threshold.trim()]),
      ),
      absolute: parseAbsolute(absolute),
    };
    // Gap-born entries carry provenance ("... PR #N ...") -> origin "pr:N".
    const prNumber = prefill?.provenance?.match(/PR #(\d+)/)?.[1];
    setError(null);
    try {
      await createMutation.mutateAsync({
        ...spec,
        origin: prNumber ? `pr:${prNumber}` : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return; // keep the dialog open so the draft can be fixed
    }
    onCreate?.(spec);
    onOpenChange(false);
  };

  const knobField = (key: keyof Knobs, label: string) => (
    <div className="space-y-1.5">
      <Label
        htmlFor={`ne-${key}`}
        className="text-[13px] text-muted-foreground"
      >
        {label}
      </Label>
      <Input
        id={`ne-${key}`}
        type="number"
        min={1}
        value={knobs[key]}
        onChange={(e) =>
          setKnobs((k) => ({ ...k, [key]: e.target.value }))
        }
        className="h-9 font-mono text-sm"
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New eval</DialogTitle>
          <DialogDescription>
            {prefill?.provenance ??
              "A named scenario plus the thresholds it must hold. " +
                "Inferval runs the benchmark for you."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="ne-name" className="text-[13px] text-muted-foreground">
              Name
            </Label>
            <Input
              id="ne-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="generate_batch8"
              className="h-9 font-mono text-sm"
            />
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label className="text-[13px] text-muted-foreground">
              Scenario
            </Label>
            <div className="grid grid-cols-3 gap-2">
              {knobField("tokens", "Tokens")}
              {knobField("batch", "Batch")}
              {knobField("repeats", "Repeats")}
            </div>
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label className="text-[13px] text-muted-foreground">Checks</Label>
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
                    <SelectTrigger size="sm" className="h-8 flex-1 font-mono text-xs">
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
                    className="h-8 w-24 font-mono text-xs"
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
                className="w-full px-2.5 py-1.5 text-left font-mono text-[13px] text-faint hover:text-foreground"
              >
                + Add check
              </button>
            </div>
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="ne-abs" className="text-[13px] text-muted-foreground">
              Absolute limit (optional)
            </Label>
            <Input
              id="ne-abs"
              value={absolute}
              onChange={(e) => setAbsolute(e.target.value)}
              placeholder="latency_ms_p95 < 3000"
              className="h-9 font-mono text-sm"
            />
          </div>
        </div>

        {prefill?.est_gpu_seconds !== undefined && (
          <p className="font-mono text-[12px] text-faint">
            est_gpu_seconds {prefill.est_gpu_seconds} · adds ~$
            {Math.max(0.01, prefill.est_gpu_seconds * (1.1 / 3600)).toFixed(2)}{" "}
            per review
          </p>
        )}

        {error && <p className="text-[13px] text-bad">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canCreate || createMutation.isPending}
            onClick={create}
          >
            {createMutation.isPending ? "Creating…" : "Create eval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
