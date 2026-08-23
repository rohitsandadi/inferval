# Notes — things to improve

## PR-scoped evals must work with zero predefined evals

Today there are two separate abilities, and only the first is complete:

1. **Narrowing** — a review's plan step picks which *existing* evals matter
   for this PR. Works, but it can only choose from the rulebook
   (`atlas.yaml`). Empty or thin rulebook → the formal review has almost
   nothing to measure.
2. **Inventing** — the PR chat agent can already highlight the risky parts
   of a diff, notice claims nothing covers, write its own quick checks in a
   sandbox, and draft new evals. But: drafts don't save anywhere, the
   improvised checks are chat evidence rather than a real pass/fail, and
   none of it reaches the deterministic verdict pipeline.

The fix, in order of value:

- **One-off scoped review.** When the agent proposes a small PR-specific
  eval, it should be runnable as a real review immediately — the proposed
  eval acts as a temporary rulebook for that one run, goes through the same
  paired measurement and pure-code verdict, and lands in the report labeled
  as PR-scoped. No `atlas.yaml` required. This is the "works even with zero
  evals" requirement.
- **Two triggers for it.** Automatic (a new PR gets triaged and, if there's
  an uncovered claim, a scoped eval is proposed and — with auto-approve —
  run), and manual (the user opens the PR, sees the highlighted parts, and
  clicks "test this").
- **Approve → persist.** An eval draft the user approves gets written into
  the suite (repo-side `atlas.yaml` change or the platform's repo store), so
  the rulebook grows from real PR traffic instead of requiring upfront
  authoring. The UI's New-eval form should persist the same way.
- **Big-repo behavior.** These combine: run the small related subset of
  existing evals (narrowing), plus one scoped eval for any new claim the
  subset doesn't cover (inventing). Neither should wait on the other.

## Smaller follow-ups

- Chat agent messages should render markdown (currently plain text).
- Session-created sandboxes don't show what they're attached to in real
  mode (one-line API mapping).
- Eval-draft Approve/Deny buttons are local-only until persistence exists.
