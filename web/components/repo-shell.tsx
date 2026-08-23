"use client";

// Shared state for the repo shell: the loaded repo + branches, the New review
// dialog opener, and per-page overrides for the topbar (crumbs + right slot).

import { createContext, useContext, type ReactNode } from "react";
import type { BranchInfo, RepoInfo } from "@/lib/types";

export interface Crumb {
  label: string;
  href?: string;
  mono?: boolean;
}

export interface RepoShellState {
  repo: RepoInfo | null;
  branches: BranchInfo[];
  openNewReview: (defaultHead?: string) => void;
  setCrumbs: (crumbs: Crumb[] | null) => void;
  setTopbarRight: (node: ReactNode | null) => void; // null = New review button
  refreshRuns: () => void; // invalidate cached run + branch summaries after submit
}

export const RepoShellContext = createContext<RepoShellState | null>(null);

export function useRepoShell(): RepoShellState {
  const ctx = useContext(RepoShellContext);
  if (!ctx) throw new Error("useRepoShell outside repo layout");
  return ctx;
}
