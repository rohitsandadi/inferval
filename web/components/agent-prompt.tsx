// The agent setup prompt copied from the overview's "Connect your coding
// agent" card.

import type { RepoInfo } from "@/lib/types";

export function agentPrompt(repo: RepoInfo): string {
  return `You have the inferval MCP server. Before opening a PR on ${repo.name}, verify your change:

1. submit_run(repo="${repo.name}", base="${repo.default_branch}", head=<your branch>)
2. Poll get_report(run_id) until the verdict lands.
3. If verdict != pass: read fix_context (suspect paths, evidence, success
   condition), fix, and re-submit. Do not open the PR on a red run.
4. Quote the inferval verdict table in your PR body instead of a speed claim.

Every run measures ${repo.evals.join(" and ")} on a paired ${repo.gpu} sandbox
with pinned image ${repo.image}; outputs must token-id match.`;
}
