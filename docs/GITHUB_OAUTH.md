# GitHub connection plan (OAuth, minimal overhead)

Goal: connect a GitHub account so Atlas can list the user's repos,
auto-connect them, and pull branches/PRs/diffs live — without building a user
system.

## The overhead ladder (pick deliberately)

| Option | Setup | Unlocks | Overhead |
| --- | --- | --- | --- |
| A. Paste a PAT | none | private repos, 5k req/h, posting | ugly UX, fine as fallback |
| **B. OAuth App, single-user (recommended)** | 5 min registration | same as A + real "Connect GitHub" flow | ~3 small pieces, no user model |
| C. GitHub App + webhooks | app registration, key signing, installs | auto-attach PRs, auto-review on open, per-repo perms | the production answer — post-event |

The trap to avoid: OAuth does NOT require accounts, cookies, or sessions on
our side. Atlas stays single-operator for the hackathon — one connected
GitHub identity, stored server-side. Multi-user auth remains explicitly out
of scope (unchanged from ARCHITECTURE §8).

## Option B design (single-user OAuth App)

**One-time manual step (Rohit, ~5 min):** GitHub → Settings → Developer
settings → OAuth Apps → New. Callback URL:
`https://atlas-verification--atlas-api.modal.run/api/auth/github/callback`.
Then `modal secret create github-oauth GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=…`.
(Agents can't do this part — it's his account.)

**Flow (authorization-code, no PKCE needed for a confidential server app):**

1. UI "Connect GitHub" → `GET /api/auth/github/login` → 302 to
   `github.com/login/oauth/authorize?client_id&scope=repo&state=<random>`
   (state stashed in the Modal Dict with a 10-min TTL).
2. GitHub redirects to our callback with `code` + `state` → API verifies
   state, exchanges code for the access token (one POST), stores it in the
   Modal Dict `atlas-github` under key `token`, fetches `GET /user` once and
   stores `login` beside it → 302 back to `FRONTEND_URL` (env; default
   `http://localhost:3000/?connected=1`).
3. Done. No cookie, no JWT: the token lives server-side only; every GitHub
   call proxies through our API. The frontend only ever learns
   `{connected: true, login}` from `GET /api/auth/github/status`.

**Storage:** Modal Dict `atlas-github` = `{token, login, connected_at}`.
Hackathon-grade honesty: it's a private workspace Dict, not a vault; say so
if asked. Disconnect = delete the key (`POST /api/auth/github/disconnect`).

**New/changed endpoints (all in one new module, `atlas/api/github_auth.py`,
mounted by the existing guarded router loop — zero edits to api.py):**

- `GET /api/auth/github/login` · `GET /api/auth/github/callback` ·
  `GET /api/auth/github/status` · `POST /api/auth/github/disconnect`
- `GET /api/github/repos` — the user's repos (name, private, default_branch,
  pushed_at), for the Connect-repo picker.
- `POST /api/repos` `{name}` — connect a repo: writes it into a
  `repos.d/` store on the runs volume (same shape as a repos.json entry;
  `_load_repos()` in api.py + sessions.py gains a 3-line merge of
  `repos.json` + `repos.d/*.json`). GPU/image/approvals start from defaults;
  evals start empty until an atlas.yaml is found in the repo root (fetch via
  the token) or drafted from a gap.

**What flips from seeded to live once a token exists** (each with the
current behavior as fallback when disconnected):

- Branches/PRs endpoint: live `GET /repos/{r}/branches` + `/pulls` instead
  of repos.json seeds.
- Session PR fetch: authenticated (5k/h, private repos work).
- The output door closes for real: the report posts as a **line-anchored PR
  review** (annotation anchors → review comments) via the token.
- "Connect repo" on Home stops being a mock.

## Effort estimate

One agent, ~2–3 hours: auth module (+state/TTL tests, token-exchange mocked),
repos picker endpoint + store merge, the live-fetch fallbacks, UI dialog
(picker + connected badge). Nothing touches the run pipeline. The 5-minute
OAuth-app registration is the only human step and can happen any time before
the agent's live test.

## Decision needed

Build now (pre-event) vs. right after the demo. Honest read: it's the
cleanest "this is a real platform" beat, but nothing in the 3-minute demo
script requires it — the demo repo is public and already connected. If
event-morning time gets tight, Option A (paste-a-PAT behind the same
status/proxy endpoints) preserves every downstream unlock for 30 minutes of
work and can be upgraded to B without changing any consumer.
