"use client";

// New review dialog (wireframe screen 5). Base/Head are branch Selects whose
// last option swaps to a SHA input; the claim auto-fills from the head PR.

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import { useRepoShell } from "@/components/repo-shell";
import { submitRun } from "@/lib/api";
import type { BranchInfo, Mode, RepoInfo } from "@/lib/types";

const CUSTOM = "__sha__";

function RefField({
  id,
  options,
  value,
  custom,
  onValue,
  onCustom,
}: {
  id: string;
  options: string[];
  value: string;
  custom: boolean;
  onValue: (v: string) => void;
  onCustom: (on: boolean) => void;
}) {
  if (custom) {
    return (
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          placeholder="SHA"
          className="h-9 pr-9 font-mono text-sm"
          autoFocus
        />
        <button
          type="button"
          aria-label="Back to branches"
          onClick={() => {
            onCustom(false);
            onValue(options[0] ?? "");
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === CUSTOM) {
          onCustom(true);
          onValue("");
        } else {
          onValue(v as string);
        }
      }}
    >
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue className="font-mono text-xs" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o} className="font-mono text-xs">
            {o}
          </SelectItem>
        ))}
        <SelectItem value={CUSTOM} className="text-xs text-muted-foreground">
          Enter a SHA…
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

export function NewReviewDialog({
  repo,
  branches,
  defaultHead,
  open,
  onOpenChange,
}: {
  repo: RepoInfo;
  branches: BranchInfo[];
  defaultHead?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { refreshRuns } = useRepoShell();

  const branchNames = useMemo(() => branches.map((b) => b.name), [branches]);
  const baseOptions = useMemo(() => {
    const set = new Set<string>([repo.default_branch, ...branchNames]);
    return [...set];
  }, [repo.default_branch, branchNames]);
  const headOptions = branchNames.length > 0 ? branchNames : [];

  const [mode, setMode] = useState<Mode>("compare");
  const [selection, setSelection] = useState<"auto" | "all" | "pick">("auto");
  const [picked, setPicked] = useState<Set<string>>(new Set(repo.evals));
  const [base, setBase] = useState(repo.default_branch);
  const [baseCustom, setBaseCustom] = useState(false);
  const [head, setHead] = useState("");
  const [headCustom, setHeadCustom] = useState(false);
  const [claim, setClaim] = useState("");
  const [claimEdited, setClaimEdited] = useState(false);
  const [autoApprove, setAutoApprove] = useState(true);
  const submitMutation = useMutation({ mutationFn: submitRun });

  // Reset per open; head follows defaultHead (row buttons pass the branch).
  useEffect(() => {
    if (!open) return;
    // Reset the controlled form each time it opens for a different branch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode("compare");
    setSelection("auto");
    setPicked(new Set(repo.evals));
    setBase(repo.default_branch);
    setBaseCustom(false);
    setHeadCustom(false);
    // Default head: the branch most in need of a review — an open PR that
    // was never reviewed, else any unreviewed branch, else any PR branch,
    // else the first branch. The claim below follows whichever wins.
    const candidates = branches.filter((b) => b.name !== repo.default_branch);
    const h =
      defaultHead ??
      candidates.find((b) => b.pr && b.state === "unverified")?.name ??
      candidates.find((b) => b.state === "unverified")?.name ??
      candidates.find((b) => b.pr)?.name ??
      headOptions[0] ??
      "";
    setHead(h);
    setClaimEdited(false);
    setClaim(branches.find((b) => b.name === h)?.pr?.claim ?? "");
    setAutoApprove(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultHead]);

  const headPR = branches.find((b) => b.name === head)?.pr ?? null;
  const claimFromPR = !claimEdited && headPR?.claim != null && claim === headPR.claim;

  const onHeadChange = (v: string) => {
    setHead(v);
    if (!claimEdited) {
      setClaim(branches.find((b) => b.name === v)?.pr?.claim ?? "");
    }
  };

  const canSubmit =
    !submitMutation.isPending &&
    base.trim() !== "" &&
    (mode === "check" || head.trim() !== "");

  const onSubmit = async () => {
    const res = await submitMutation.mutateAsync({
        repo: repo.name,
        mode,
        base: base.trim(),
        head: mode === "compare" ? head.trim() : undefined,
        evals:
          selection === "auto"
            ? null
            : selection === "all"
              ? repo.evals
              : [...picked],
        approvals: autoApprove ? "auto" : "manual",
        claim: claim.trim() || undefined,
    });
    toast(`Review ${res.run} queued`);
    refreshRuns();
    onOpenChange(false);
    router.push(`/repo/${repo.name}/reviews/${res.run}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New review</DialogTitle>
          <DialogDescription>
            Paired measurement on one {repo.gpu}. Verdict comes from the
            suite&apos;s thresholds.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="nr-mode" className="text-[13px] text-muted-foreground">
              Mode
            </Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as Mode)}
              items={{ compare: "Compare", check: "Check" }}
            >
              <SelectTrigger id="nr-mode" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="compare">Compare</SelectItem>
                <SelectItem value="check">Check</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nr-evals" className="text-[13px] text-muted-foreground">
              Evals
            </Label>
            <Select
              value={selection}
              onValueChange={(v) => setSelection(v as "auto" | "all" | "pick")}
              items={{
                auto: "Auto",
                all: `All (${repo.evals.length})`,
                pick: "Pick",
              }}
            >
              <SelectTrigger id="nr-evals" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="all">All ({repo.evals.length})</SelectItem>
                <SelectItem value="pick">Pick</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selection === "pick" && (
            <div className="col-span-2 rounded-md border border-border">
              {repo.evals.map((name) => (
                <label
                  key={name}
                  className="flex items-center gap-2 border-b border-border-soft px-2.5 py-1.5 font-mono text-xs last:border-b-0"
                >
                  <Checkbox
                    checked={picked.has(name)}
                    onCheckedChange={(v) => {
                      const next = new Set(picked);
                      if (v === true) next.add(name);
                      else next.delete(name);
                      setPicked(next);
                    }}
                  />
                  {name}
                </label>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="nr-base" className="text-[13px] text-muted-foreground">
              Base
            </Label>
            <RefField
              id="nr-base"
              options={baseOptions}
              value={base}
              custom={baseCustom}
              onValue={setBase}
              onCustom={setBaseCustom}
            />
          </div>
          {mode === "compare" && (
            <div className="space-y-1.5">
              <Label htmlFor="nr-head" className="text-[13px] text-muted-foreground">
                Head
              </Label>
              <RefField
                id="nr-head"
                options={headOptions}
                value={head}
                custom={headCustom}
                onValue={onHeadChange}
                onCustom={setHeadCustom}
              />
            </div>
          )}

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="nr-claim" className="text-[13px] text-muted-foreground">
              Claim
            </Label>
            <Input
              id="nr-claim"
              value={claim}
              onChange={(e) => {
                setClaim(e.target.value);
                setClaimEdited(true);
              }}
              placeholder="what the change is supposed to do"
              className="h-9 text-sm"
            />
            {claimFromPR && headPR && (
              <p className="text-[12px] text-faint">
                auto-filled from PR #{headPR.number} — edit to override
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-soft pt-3">
          <div>
            <Label htmlFor="nr-auto" className="text-xs">
              Auto-approve probes
            </Label>
            <p className="text-[13px] text-faint">
              Follow-up experiments run without waiting for approval
            </p>
          </div>
          <Switch
            id="nr-auto"
            checked={autoApprove}
            onCheckedChange={setAutoApprove}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={onSubmit}>
            {submitMutation.isPending ? "Starting…" : "Start review"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
