// Inferval MCP server — the door for any user's coding agent, at /api/mcp
// over streamable HTTP. Every tool is one HTTP call to the deployed API;
// zero logic lives here. Port of the retired local Python stdio server.

import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const API =
  process.env.NEXT_PUBLIC_ATLAS_API ||
  "https://atlas-verification--atlas-api.modal.run";

const GUIDE = `Inferval verifies performance/behavior claims about inference code on real
GPUs. Core ideas:

- A repo has EVALS: named measurement recipes. Each eval = a bench command
  plus limits it must hold. Metrics: tokens_per_s, latency_ms_median,
  latency_ms_p95, peak_vram_mb.
- Two kinds of limits. checks (compare mode, old-vs-new): "tokens_per_s":
  "-10%" means the new code may not be more than 10% slower; "+15%" on a
  latency metric means it may not be more than 15% higher. absolute (check
  mode, single version): "latency_ms_p95": "<3000".
- A REVIEW runs evals as a paired experiment (base, head, head, base on one
  GPU, fresh process per block); a pure-code referee issues the verdict
  (pass / regression / invalid) — no model in the verdict. On regression an
  investigator agent diagnoses why. Output: a report + PR comment.
- Eval cmd template placeholders: {src} = the checked-out revision's path,
  {out} = where the bench must write its metrics JSON. Demo-repo example:
  "python /harness/bench.py --src {src} --eval generate_short --tokens 128
  --batch 2 --repeats 5 --out {out}".

Typical agent flow: connect_repo -> study the repo -> create_eval for each
scenario worth guarding (start with 2-3: a short and a long/heavier one;
thresholds ~3-5x the measurement noise, e.g. -10% tokens_per_s) ->
submit_review on a change -> get_run until done -> get_report.

For a pull request, review_pr does the whole arc in one call: a background
worker triages the diff, checks which stored evals cover it, may propose one
tightly constrained scoped eval for an uncovered claim, and submits the
review. It works even when the repo has no evals defined yet.

A repo's suite merges two sources, and list_evals shows both: "seed" evals
ship with the repo's own config (read-only here), "store" evals were created
via create_eval and can be replaced or deleted. A store eval with a seed
eval's name overrides it — create_eval requires replace: true for that.
review_pr and submit_review start paid GPU runs; everything else is free.
`;

async function apiDelete(path: string) {
  const r = await fetch(`${API}${path}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status >= 400) throw new Error(`${r.status}: ${await detail(r)}`);
  return r.json();
}

async function apiGet(path: string) {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (r.status >= 400) throw new Error(`${r.status}: ${await detail(r)}`);
  return r.json();
}

async function apiPost(path: string, body: object) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (r.status >= 400) throw new Error(`${r.status}: ${await detail(r)}`);
  return r.json();
}

// Surface the API's validation message (e.g. threshold-format errors) so the
// calling agent can self-correct.
async function detail(r: Response): Promise<string> {
  const text = await r.text();
  try {
    return JSON.parse(text).detail ?? text;
  } catch {
    return text;
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const dump = (v: unknown) => text(JSON.stringify(v, null, 1));

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_started",
      { description: "How Inferval works and how to write evals. Read this first." },
      async () => text(GUIDE),
    );

    server.registerTool(
      "list_repos",
      { description: "Connected repos with their eval names and review counts." },
      async () => {
        const repos: Array<Record<string, unknown>> = await apiGet("/api/repos");
        return dump(
          repos.map((r) => ({
            name: r.name,
            evals: r.evals,
            reviews: r.runs_count ?? 0,
          })),
        );
      },
    );

    server.registerTool(
      "connect_repo",
      {
        description: "Connect a public GitHub repo by owner/repo name.",
        inputSchema: z.object({ name: z.string() }),
      },
      async ({ name }) => dump(await apiPost("/api/repos", { name })),
    );

    server.registerTool(
      "list_evals",
      {
        description:
          "The repo's full effective eval suite. source \"seed\" entries come " +
          "from the repo's own config (read-only here; a create_eval with the " +
          "same name and replace: true overrides one); source \"store\" " +
          "entries were created via create_eval and can be replaced or deleted.",
        inputSchema: z.object({ repo: z.string() }),
      },
      async ({ repo }) => {
        const stored: Array<Record<string, unknown>> = await apiGet(
          `/api/repos/${repo}/evals`,
        );
        const repos: Array<Record<string, unknown>> = await apiGet("/api/repos");
        const entry = repos.find((r) => r.name === repo);
        const storeNames = new Set(stored.map((e) => e.name));
        const seeded = ((entry?.evals as string[]) ?? [])
          .filter((name) => !storeNames.has(name))
          .map((name) => ({ name, source: "seed", read_only: true }));
        return dump([
          ...seeded,
          ...stored.map((e) => ({ ...e, source: "store" })),
        ]);
      },
    );

    server.registerTool(
      "create_eval",
      {
        description:
          "Create or replace one eval. See get_started for cmd placeholders and " +
          'threshold formats. checks example: {"tokens_per_s": "-10%", ' +
          '"latency_ms_p95": "+15%"}; absolute example: {"latency_ms_p95": "<3000"}.',
        inputSchema: z.object({
          repo: z.string(),
          name: z.string(),
          cmd: z.string(),
          checks: z.record(z.string(), z.string()),
          absolute: z.record(z.string(), z.string()).optional(),
          replace: z.boolean().optional(),
        }),
      },
      async ({ repo, name, cmd, checks, absolute, replace }) => {
        if (!replace) {
          // collision guard: overriding an existing eval (stored or seeded)
          // must be explicit — pass replace: true to mean it
          const stored: Array<Record<string, unknown>> = await apiGet(
            `/api/repos/${repo}/evals`,
          );
          const repos: Array<Record<string, unknown>> = await apiGet(
            "/api/repos",
          );
          const entry = repos.find((r) => r.name === repo);
          const taken =
            stored.some((e) => e.name === name) ||
            ((entry?.evals as string[]) ?? []).includes(name);
          if (taken) {
            throw new Error(
              `an eval named "${name}" already exists for ${repo}; ` +
                "pass replace: true to override it",
            );
          }
        }
        const body: Record<string, unknown> = { name, cmd, checks };
        if (absolute) body.absolute = absolute;
        return dump(await apiPost(`/api/repos/${repo}/evals`, body));
      },
    );

    server.registerTool(
      "delete_eval",
      {
        description:
          "Delete one stored eval by name (evals seeded from the repo's own " +
          "yaml cannot be deleted here).",
        inputSchema: z.object({ repo: z.string(), name: z.string() }),
      },
      async ({ repo, name }) =>
        dump(await apiDelete(`/api/repos/${repo}/evals/${name}`)),
    );

    server.registerTool(
      "review_pr",
      {
        description:
          "STARTS A PAID GPU REVIEW RUN — confirm with your user before " +
          "calling. Reviews a pull request end to end: a background worker " +
          "triages the diff, checks eval coverage, may propose one " +
          "constrained scoped eval for an uncovered claim, and submits the " +
          "formal review. Works on repos with no evals defined. Returns the " +
          "session id; the run appears a few minutes later.",
        inputSchema: z.object({ repo: z.string(), pr: z.number().int() }),
      },
      async ({ repo, pr }) =>
        dump(await apiPost(`/api/repos/${repo}/prs/${pr}/review`, {})),
    );

    server.registerTool(
      "submit_review",
      {
        description:
          "STARTS A PAID GPU REVIEW RUN — confirm with your user before " +
          "calling. compare mode needs base and head (branch or SHA); check " +
          "mode measures base alone against absolute limits. evals: names to " +
          "run (omit = the agent-planned selection). claim: what the change says " +
          "it does — the verdict checks it. Returns the run id.",
        inputSchema: z.object({
          repo: z.string(),
          base: z.string(),
          head: z.string().optional(),
          mode: z.string().default("compare"),
          evals: z.array(z.string()).optional(),
          claim: z.string().optional(),
        }),
      },
      async ({ repo, base, head, mode, evals, claim }) => {
        const body: Record<string, unknown> = {
          repo,
          mode: mode ?? "compare",
          base_sha: base,
          selection: evals?.length ? "pick" : "auto",
          approvals: "auto",
        };
        if (head) {
          body.head_sha = head;
          body.branch = head;
        }
        if (evals?.length) body.evals = evals;
        if (claim) body.claim = claim;
        return dump(await apiPost("/api/runs", body));
      },
    );

    server.registerTool(
      "get_run",
      {
        description:
          "Status + verdict for a review. Poll until status is 'done' " +
          "(a review takes 3-15 minutes).",
        inputSchema: z.object({ run_id: z.string() }),
      },
      async ({ run_id }) => {
        const d = await apiGet(`/api/runs/${run_id}`);
        const v = d.verdict ?? {};
        return dump({
          run: run_id,
          status: d.status ?? null,
          verdict: v.verdict ?? null,
          checks: v.checks ?? null,
          cost_usd: d.cost_usd ?? null,
        });
      },
    );

    server.registerTool(
      "get_report",
      {
        description:
          "The finished review's report: findings, diagnosis, PR comment.",
        inputSchema: z.object({ run_id: z.string() }),
      },
      async ({ run_id }) => {
        const d = await apiGet(`/api/runs/${run_id}/report`);
        return dump({
          summary: d.summary ?? null,
          flagged: d.flagged ?? null,
          pr_comment_md: d.pr_comment_md ?? null,
        });
      },
    );
  },
  {
    serverInfo: { name: "inferval", version: "0.1.0" },
    instructions:
      "Evals and verification for inference code on real GPUs. " +
      "Call get_started first for the concepts and eval format.",
  },
);

export { handler as GET, handler as POST, handler as DELETE };
export const maxDuration = 60;
