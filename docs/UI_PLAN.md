# Atlas UI v2 (git-centric) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `atlas_v1/web/` to the approved rev-5 wireframes: a Vercel/shadcn
dashboard where a branch/PR is the unit of verification.

**Architecture:** Next.js App Router with a persistent repo-level sidebar layout;
all data through `web/lib/api.ts` (mock mode without `NEXT_PUBLIC_ATLAS_API`);
one new backend endpoint (branches) built by the Phase-4 agent against the
contract frozen below. UI reuses the existing trace/checks/proposal/report
component internals and restyles them.

**Tech Stack:** Next.js 16, Tailwind 4, shadcn/ui (stock components), Geist +
Geist Mono, TypeScript. Backend: existing FastAPI in `atlas/api/api.py`.

**Spec:** `v2/wireframes-rev5.html` (open it in a browser — it IS the design,
screen numbers below refer to it). Supporting docs: `v2/ARCHITECTURE.md` §6,
existing code in `atlas_v1/web/`.

## Global Constraints

- Text rule: every string is a metric, a name, or a control. No taglines, no
  filler ("gpu evidence, not vibes"-type copy is banned).
- Palette: ground `#000000`, surface `#0A0A0A`, borders `#2E2E2E` (hairline)
  and `#1C1C1C` (softer), text `#EDEDED`, muted `#A1A1A1`, faint `#666666`.
  Semantic only: ok `#45C486`, bad `#E5484D`, live `#0070F3`.
- Red/green appear in exactly two forms: status-dot verdicts and delta
  numbers. No filled red/green surfaces or banners.
- Status = dot + sentence-case word ("● Regression"), Vercel-deployments
  style. Live states use the blue dot.
- Typography: Geist everywhere; Geist Mono ONLY for SHAs, run ids, branch
  names, commands, thresholds, and money. Sentence-case labels; no
  uppercase-tracked micro-labels.
- Radii 6px (controls) / 8px (cards, frames). Boxy, bordered, minimal fills.
- One white primary Button per page, top-right. Secondary = bordered.
- Stock shadcn components wherever one exists; no bespoke CSS re-creations.
- Naming: the UI says **Reviews**; code identifiers and API routes keep
  "runs". Do not rename API routes.
- Mock/real parity: every page renders from `web/mocks/` when
  `NEXT_PUBLIC_ATLAS_API` is unset and from the API when set.
- Gate for every task: `npm run build` green, page visually checked in the
  browser against the wireframe screen.

## Frozen seam: branches endpoint (Phase-4 agent builds it; UI consumes it)

`GET /api/repos/{name}/branches?base=<ref>` (base defaults to the repo's
`default_branch`) returns a bare array:

```json
[{
  "name": "opt-sampling",
  "sha": "9c2b11d0",
  "pr": {"number": 4, "title": "Optimize generation…", "url": "https://github.com/…/pull/4", "claim": "…"},
  "state": "regression",
  "last_review": {"run": "hero_1787471941", "verdict": "regression",
                   "tokens_per_s_delta_pct": -33.9, "status": "done",
                   "t": "2026-08-23T08:05:20Z"},
  "reviews_count": 2
}]
```

- `pr` is `null` for plain branches; `last_review` is `null` when
  `reviews_count` is 0.
- `state` ∈ `verified | regression | running | unverified` — derived from the
  newest run whose head matches the branch and whose base matches `?base`:
  status not done → `running`; verdict pass → `verified`; verdict
  regression/invalid → `regression`; no runs → `unverified`.
- Static branch/PR facts live in `atlas/api/repos.json` under a new
  `branches: [{name, sha, pr}]` key per repo.
- UI mock: `web/mocks/branches_nanogpt.json`, exact same shape.

`POST /api/runs` already accepts `branch` and `claim`; `head_sha` may be a
branch name (the runner checks out refs). The New review dialog submits
`{repo, mode, base_sha: <base ref>, head_sha: <head ref>, branch: <head ref>,
claim, selection, evals?, approvals}`.

---

### Task 1: Theme + primitives

**Files:**
- Modify: `web/app/globals.css` (tokens → the palette above; true black)
- Modify: `web/components/atoms.tsx` (drop uppercase SectionLabel styling)
- Create: `web/components/status-dot.tsx`
- Delete after migration completes (Task 10): `web/components/verdict-badge.tsx`
- Modify: `web/lib/types.ts`

**Interfaces (Produces):**

```tsx
// status-dot.tsx
export type DotState = "ok" | "bad" | "busy" | "idle";
export function StatusDot({ state, label }: { state: DotState; label: string }): JSX.Element;
// renders: <span><i dot/> {label}</span> — dot colored, label --text at 90%
export function verdictDot(verdict: VerdictKind | null, status?: string): { state: DotState; label: string };
// pass→ok "Pass"; regression/invalid→bad; null+running status→busy with
// capitalized status label; null otherwise→idle "Unverified"
```

```ts
// types.ts additions
export interface BranchPR { number: number; title: string; url: string; claim?: string }
export interface BranchInfo {
  name: string; sha: string; pr: BranchPR | null;
  state: "verified" | "regression" | "running" | "unverified";
  last_review: { run: string; verdict: VerdictKind | null; tokens_per_s_delta_pct: number | null; status: string; t: string } | null;
  reviews_count: number;
}
```

- [ ] Install the missing shadcn components: `npx shadcn@latest add tabs dialog select switch dropdown-menu skeleton collapsible sonner breadcrumb` (keep existing ones).
- [ ] Update `globals.css` tokens to the palette (background pure black; border hairlines).
- [ ] Write `status-dot.tsx` per the interface; render one of each state on a scratch page or storybook-less visual check via the home page.
- [ ] Add `BranchInfo`/`BranchPR` to `types.ts`.
- [ ] `npm run build` green. Commit is left to the coordinator (report instead).

### Task 2: Data layer

**Files:**
- Modify: `web/lib/api.ts`
- Create: `web/mocks/branches_nanogpt.json` (4 branches per wireframe screen 3, real claims from `atlas_v1/demo/PIN.md`)

**Interfaces (Produces):**

```ts
export async function getBranches(repo: string, base?: string): Promise<BranchInfo[]>;
// real: GET /api/repos/{repo}/branches?base=…  mock: branches_nanogpt.json
// submitRun body gains branch + claim passthrough (NewRunRequest gains claim?: string, head is a ref)
```

- [ ] Add `getBranches` with mock + real modes; extend `NewRunRequest` with `claim?`.
- [ ] Mock file uses the PIN.md claims verbatim and states: opt-sampling `regression`, opt-allocation `verified`, fix-sampling `running`, experiment/kv-cache `unverified`.
- [ ] `npm run build` green.

### Task 3: Repo shell layout

**Files:**
- Create: `web/app/repo/[owner]/[name]/layout.tsx`
- Create: `web/components/repo-sidebar.tsx`
- Create: `web/components/new-review-dialog.tsx` (shell only this task; full form Task 7)

**Interfaces (Produces):**

```tsx
// layout.tsx: topbar = Breadcrumb (Atlas / owner/name / …) + <NewReviewButton/>
// (opens NewReviewDialog); left sidebar links: Overview → /repo/o/n,
// Branches & PRs → …/branches, Reviews → …/reviews, Evals → …/evals;
// active state via usePathname(). Children render right of the sidebar.
// NewReviewDialog accepts { repo: RepoInfo; branches: BranchInfo[];
//   defaultHead?: string } and is openable from any page via a small
//   context or by lifting state into the layout.
```

- [ ] Build the layout per wireframe screens 2–12 (sidebar 150–180px, main content 20–24px padding, breadcrumb topbar with the one primary button).
- [ ] Move existing `/repo/[owner]/[name]/page.tsx` content temporarily under the new layout (it becomes Overview in Task 5).
- [ ] Verify: sidebar navigation works between stub pages; build green.

### Task 4: Home page (wireframe screen 1)

**Files:**
- Modify: `web/app/page.tsx`

- [ ] Card grid (3 cols responsive): name (sans, medium), `⋯` DropdownMenu (copy clone URL, open on GitHub), Badge row (GPU, `N evals`, `N branches` — branch count from `getBranches` for the demo repo, omit if unknown), footer = StatusDot summary ("1 regression open" if any branch state is regression, "All verified" if all verified, else "no reviews yet") + `N reviews`.
- [ ] Search Input filters cards client-side; "Connect repo" primary button (no-op).
- [ ] Skeleton cards while loading. Verify against screen 1; build green.

### Task 5: Overview page (screen 2)

**Files:**
- Rewrite: `web/app/repo/[owner]/[name]/page.tsx`

- [ ] Pin line (mono, faint): `base: <default_branch> @ <sha> · <image>`.
- [ ] Four stat Cards: Open changes (`N branches · N PRs`), Needs attention (StatusDot + `N regression` / ok "All verified"), Suite (`N evals`), Total spend (sum of run `cost_usd`, mono).
- [ ] Changes table: branch (mono + PR Badge), claim (italic, truncated), state vs base (StatusDot + delta), last review time. Rows link to `/branches/[branch]`.
- [ ] Agent card: title "Connect your coding agent", one line, "Copy prompt" secondary button (copies the existing agent setup prompt text to clipboard, Sonner "Copied").
- [ ] Verify against screen 2; build green.

### Task 6: Branches pages (screens 3 + 4)

**Files:**
- Create: `web/app/repo/[owner]/[name]/branches/page.tsx`
- Create: `web/app/repo/[owner]/[name]/branches/[branch]/page.tsx`
- Create: `web/components/review-timeline.tsx`

**Interfaces (Produces):**

```tsx
// review-timeline.tsx
export function ReviewTimeline({ items }: { items: TimelineItem[] }): JSX.Element;
export interface TimelineItem { kind: "review" | "pr_opened"; run?: RunSummary; t: string; note?: string }
// rail of dots colored by verdict state, newest first, review rows link to the review page
```

- [ ] Branches list: Base Select (repo branches; default `default_branch`) + search Input; table per screen 3 (branch+PR badge, claim italic, StatusDot state with delta, reviews count, per-row "Review" secondary button → opens NewReviewDialog with `defaultHead`).
- [ ] Branch detail: header (branch mono, PR badge linking to the PR url, StatusDot, `sha · vs base @ sha`), claim blockquote (left border), ReviewTimeline built from `listRuns` filtered to this branch (branch field or head match) + a final `pr_opened` item when `pr` exists. "Review this branch" primary in the topbar area of the page.
- [ ] Verify both against screens 3–4; build green.

### Task 7: New review + New eval dialogs (screens 5 + 6)

**Files:**
- Rewrite: `web/components/new-review-dialog.tsx` (replaces `new-run-form.tsx`; delete the old file)
- Create: `web/components/new-eval-dialog.tsx`

- [ ] New review Dialog: Mode Select (Compare/Check), Evals Select (Auto/All/Pick — Pick reveals a Checkbox list of suite evals), Base + Head branch Selects (options from `getBranches` + last option "Enter a SHA…" which swaps to a mono Input), Claim Input (auto-fills from the head branch's `pr.claim` when present, editable, helper text "from PR #N"), auto-approve Switch (maps to `approvals: "auto" | "manual"`), Cancel + "Start review" primary. Submit → `submitRun` → Sonner toast `Review <id> queued` → router push to the review page.
- [ ] New eval Dialog per screen 6: Name (mono Input), GPU Select, Command (mono Input), Checks editable list (metric Select from the four known metrics + threshold Input, add/remove rows), optional absolute Input. "Create eval" adds the eval to local page state only (no persistence endpoint yet — this is a core-feature mock; keep the button normal-looking).
- [ ] Verify against screens 5–6 in both open states; build green.

### Task 8: Reviews log (screen 7)

**Files:**
- Create: `web/app/repo/[owner]/[name]/reviews/page.tsx` (move + restyle the existing runs-table content)
- Modify: `web/components/runs-table.tsx` → review rows per screen 7

- [ ] Filter bar: search Input + branch Select + verdict Select (client-side filtering).
- [ ] Table columns exactly: Review (mono id), Change (`head → base`, mono dim), Verdict (StatusDot), tokens/s Δ, p95 Δ, Cost, Status (StatusDot, blue for live), right-aligned relative time. Row click → review page.
- [ ] Live rows keep polling via the existing status refresh path. Skeleton rows while loading. Verify against screen 7; build green.

### Task 9: Review detail as tabs (screens 8–11)

**Files:**
- Move: `web/app/repo/[owner]/[name]/runs/[id]/page.tsx` → `web/app/repo/[owner]/[name]/reviews/[id]/page.tsx` (add a redirect from the old path)
- Modify: `web/components/checks-table.tsx`, `web/components/trace.tsx`, `web/components/proposal-card.tsx`, `web/components/report-section.tsx`

- [ ] Header: run id (mono) · `head → base` (mono dim) · verdict StatusDot; lifecycle Badge chain (queued → … → done, current one blue); cost in the topbar area with a Tooltip (GPU seconds).
- [ ] Tabs: Verdict / Proposals / Trace / Report. Keep the events polling + replay logic exactly as is — this task is restyling and re-slotting, not logic.
- [ ] Verdict tab (screen 8): claim blockquote with inline red "not true by measurement" when `claim.verified === false`; checks Table (Eval / Metric / Base / Candidate / Δ / Threshold — red only on violated Δ); correctness row with ok StatusDot. Delete the filled red banner.
- [ ] Proposals tab (screen 9): card per proposal — id + kind (mono), StatusDot (busy "Awaiting approval" / ok "Done" / idle "Denied"/"Expired"), est cost right-aligned, reason paragraph, params (mono, faint), footer: expiry countdown when pending + Deny (red-text outline) / Approve (primary) wired to `decideProposal`.
- [ ] Trace tab (screen 10): phase groups (Collapsible, default open) with uppercase-free phase labels, rows = time (mono faint) + tier Badge (system neutral / policy amber-text / agent blue-text) + kind (mono) + detail summary + evidence refs as links (`artifactUrl`).
- [ ] Report tab (screen 11): Diagnosis Card with confidence Badge; PR-comment Card rendering the markdown inside a bordered frame with "Copy markdown" button; fix-context Card with an Expand Collapsible showing the JSON (mono, small).
- [ ] Verify each tab against screens 8–11 using the mock regression run AND the live-API hero run; build green.

### Task 10: Evals page (screen 12) + cleanup

**Files:**
- Create: `web/app/repo/[owner]/[name]/evals/page.tsx`
- Delete: `web/components/verdict-badge.tsx`, `web/components/new-run-form.tsx`, the old `/runs/[id]` page body (after redirect), any now-unused atoms

- [ ] Header row: `atlas.yaml @ <default_branch> · correctness: <rule> · overrides: <list>` (mono faint) + "New eval" secondary button.
- [ ] Evals Table: name (mono), command (mono faint, truncated), checks as Badges (`tokens/s ≥ -10%` formatting), last result (delta from the newest run's checks for that eval, red/green number or `—`).
- [ ] Full sweep: `npm run build` green; click through every route in mock mode; then with `NEXT_PUBLIC_ATLAS_API=https://atlas-verification--atlas-api.modal.run` verify Home, Overview, Reviews log, and the hero review render real data (branches endpoint may 404 until Phase 4 lands — the UI must degrade to an empty-state row, not crash).
- [ ] Grep the app for banned copy patterns (taglines, uppercase tracking labels); remove leftovers.

## Self-review notes

- Spec coverage: screens 1–12 map to Tasks 4,5,3/6,6,7,7,8,9,9,9,9,10 — all covered; the shell (topbar/sidebar) is Task 3.
- Types: `StatusDot`/`verdictDot`, `BranchInfo`, `getBranches` signatures are single-sourced in Tasks 1–2 and consumed in 4–9 as written.
- The branches endpoint may not exist while the UI is built — mock mode plus the empty-state rule in Task 10 keeps the tracks independent.
