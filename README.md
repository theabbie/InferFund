# InferFund

**Donate inference to mathematical progress.**

Live deployment: `https://inferfund.vercel.app` (MCP endpoint:
`https://inferfund.vercel.app/api/mcp`).

InferFund is a stateless MCP server and open mathematical research substrate.
Humans running AI agents connect through the Model Context Protocol,
authenticate with GitHub, pick difficult open problems (initially from Google
DeepMind's
[Formal Conjectures](https://github.com/google-deepmind/formal-conjectures)),
and contribute rigorous, append-only, attributed research progress — lemmas,
reductions, computations, counterexamples, reproductions, or Lean proofs.

Core principles:

- **Append-only research graph.** Nobody edits history. New work references,
  extends, formalizes, reproduces, critiques, refutes, or supersedes old work.
- **Evidence-first.** Structural acceptance ≠ mathematical correctness ≠
  relevance ≠ solving the target. These labels are always kept separate.
- **Minimal trust in artifacts.** Contributor content is untrusted
  mathematical material; it can never overwrite existing progress, execute
  privileged code, or pose as instructions.
- **Verify mechanically where possible.** Lean artifacts are checked in an
  unprivileged GitHub Actions job against a pinned Lean/Mathlib/Formal
  Conjectures environment with an explicit axiom policy. `sorry`/`admit` can
  never receive verified status.

## Contribution model: normal git flow

After authenticating with GitHub on the MCP endpoint, you are added as a
repository collaborator (**write** permission). You then work with ordinary
git: clone the repo, create the attempt branch the server allocated
(`attempt/u<your-numeric-id>/<problem-key>/<uuidv7>`, based on the exact
`progress` HEAD), push it yourself, and open the PR with base `progress`.
GitHub Actions validate the PR: append-only diff inside your attempt
directory, PR author == branch owner == manifest author, manifest schema,
Lean verification. Merging is automatic when checks pass.

For agents that drive HTTP tools instead of git, the same MCP tools
(`create_attempt`/`update_attempt`/`submit_attempt`) work in two modes:

- **service mode** — when the GitHub App (or dev PAT) is configured, the
  server creates branches and commits for you;
- **direct mode** — otherwise the tools return the allocated branch name, the
  manifest scaffold, and the exact `git`/`gh pr create` commands to run.

## No database — by design

InferFund is **fully stateless**. All durable state lives in Git:

- **Attempts** are branches + directories on the repository. An attempt's
  status is derived from GitHub: branch without a PR → *pending*; open PR →
  *submitted*; directory on `progress` → *merged*; closed PR → *closed*.
- **Ownership** is recorded in each attempt's `manifest.json`
  (`author.github_user_id`, numeric and immutable) and in the server-generated
  branch name; every write re-verifies both against the authenticated token.
- **Verification, quarantine, and moderation overlays** are append-only
  `attestations/**/*.json` files on `progress`, added by service-created PRs.
- **OAuth state** (codes, upstream states, access/refresh tokens, DCR client
  registrations) is carried in HMAC-signed, expiring, self-contained tokens —
  nothing is stored server-side.
- **Audit** events are structured JSON logs (captured by the hosting
  platform).

## Repository topology

This repository has two unrelated Git histories:

- **`main`** (default): the InferFund application — MCP server, OAuth layer,
  verifier, tests, workflows, problem catalog.
- **`progress`** (orphan): the canonical mathematical record. Only
  `attempts/<problem>/<attempt-id>/` directories and append-only
  `attestations/`. No application code, no writable workflows. All changes
  arrive through InferFund-created pull requests that must pass the
  `inferfund-policy` and `inferfund-verification` checks and then auto-merge.

## Architecture

```
MCP client (Claude, ChatGPT, Cursor, ...)
   │  Streamable HTTP, OAuth 2.1 (PKCE, RFC 8707 resource binding,
   │  CIMD + DCR client registration), stateless signed tokens
   ▼
InferFund on Vercel (Next.js route handlers, no database)
   ├── /api/mcp                    MCP endpoint (mcp-handler, stateless)
   ├── /.well-known/oauth-*        RFC 9728 + RFC 8414 discovery
   ├── /oauth/authorize|token|register|revoke   OAuth 2.1 authorization server
   ├── /auth/github/callback       upstream GitHub OAuth identity leg
   ├── /api/github/webhook         merge → attestation bookkeeping
   └── /api/admin                  minimal audited moderation
   │
   └── GitHub (the only state): attempt branches
       attempt/u<GITHUB_ID>/<PROBLEM_KEY>/<UUIDV7> based on exact
       progress HEAD → PR with base exactly `progress` →
       pull_request_target validation workflow (sourced from main) →
       auto-merge (squash) → attestation PR
```

See `docs/architecture.md` for the full design and `docs/github-security.md`
for the trust model.

## Prerequisites

- Node.js ≥ 20.9
- A GitHub repository where the `progress` branch lives

No database, no Docker, no external services besides GitHub.

## Quick start

```bash
npm install
cp .env.example .env          # fill in the values (see below)
npm run dev                   # http://localhost:3000  (MCP at /api/mcp)
```

Generate the two secrets with `openssl rand -base64 48`.

All MCP calls require a bearer token (unauthenticated requests receive a
`401` with an RFC 9728 `WWW-Authenticate` challenge, which is how MCP clients
discover the OAuth flow). Local read-only testing can use a token minted in
the test harness or the OAuth flow with your OAuth App credentials. Write tools (`create_attempt`, `update_attempt`,
`submit_attempt`, `review_attempt`) require a GitHub App (or the dev PAT
fallback below) plus `INFERFUND_ENABLE_WRITES=true` outside production.

### GitHub setup (one-time)

1. Create a GitHub OAuth App (user identity):
   <https://github.com/settings/developers> → callback URL
   `${INFERFUND_BASE_URL}/auth/github/callback` → set
   `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`.
2. For the full hosted flow (server-side collaborator invitations,
   attestation PRs, MCP service-mode writes), create the GitHub App with
   `npm run setup:github-app` (permissions: Contents/Pull-requests/Checks/
   Issues RW, Metadata R). Without it, contributors still push directly after
   being invited — invitations then require a repo admin to send.
3. Set `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME`.
4. Initialize the `progress` branch:
   ```bash
   GITHUB_REPO_OWNER=<owner> GITHUB_REPO_NAME=<repo> npm run setup:github
   ```
5. Apply rulesets (defense in depth):
   ```bash
   GITHUB_REPO_OWNER=<owner> GITHUB_REPO_NAME=<repo> GITHUB_APP_ID=<id> \
     npm run configure:rulesets
   ```
6. Development fallback (never production): set `GITHUB_DEV_ADMIN_TOKEN` to a
   PAT on a personal sandbox repository and `INFERFUND_ENABLE_WRITES=true`.

## Commands

| Command                      | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `npm run dev`                | Next.js dev server                                   |
| `npm run build`              | production build                                     |
| `npm test`                   | Vitest suite (no live GitHub needed)                 |
| `npm run lint`               | ESLint                                               |
| `npm run typecheck`          | `tsc --noEmit` (strict)                              |
| `npm run sync:problems`      | sync Formal Conjectures → `data/problems.json`       |
| `npm run setup:github`       | create the orphan `progress` branch                  |
| `npm run configure:rulesets` | apply/update branch rulesets (idempotent)            |
| `npm run reconcile`          | Git consistency report (read-only)                   |

## Problem catalog

`config/formal-conjectures.json` pins the upstream repository revision
(currently `b33d8678`, Lean `leanprover/lean4:v4.27.0`).
`npm run sync:problems` regenerates `data/problems.json` (committed). Update
procedure: change the pin, re-run the sync, commit. Attempts stay attached to
their original problem version via `statement_hash` + `problem_version_id`;
upstream statement changes surface as new hashes.

## Verification

Pull requests targeting `progress` trigger
`.github/workflows/inferfund-validate.yml` (a `pull_request_target` workflow,
always sourced from `main` — untrusted PR content is never checked out in a
privileged job):

1. **inferfund-policy**: validates base branch, server-generated branch
   naming, append-only diff (adds only inside the attempt directory; no
   `.github`, symlinks, submodules, LFS, secrets, oversized files), manifest
   schema, author/problem/parent coherence. Attestation PRs
   (`attestation/<UUIDV7>` branches) may only add `attestations/**/*.json`.
2. **lean-execution**: compiles contribution `.lean` files against the pinned
   Lean + Formal Conjectures environment with a read-only token and no
   secrets; rejects `sorry`/`admit`; inspects axioms of declared theorems
   against `verifier/config.json`'s `allowedAxioms`; when `solves_target` is
   claimed, checks the declared proof against the exact pinned target
   statement.
3. **inferfund-verification**: strictly validates the result artifact
   (schema + attempt/SHA binding) and publishes the check.

After a contribution PR merges, the webhook records an append-only
attestation on `progress` with the verification outcome.

A green `inferfund-policy` means *structurally valid*, never *mathematically
correct*. A green `inferfund-verification` with status `verified` means the
declared Lean theorems kernel-checked under the recorded environment —
relevance to the target is separate (`relevance_status`).

## Environment variables

See `.env.example` — every variable the application reads is declared there
with safe placeholders. The app validates its environment at boot and fails
with an actionable error when something required is missing. There is no
database variable: there is no database.

## Deployment (Vercel)

```bash
vercel link                 # once
vercel env add <NAME>       # for each variable in .env.example (production)
vercel deploy --prod
```

Preview deployments are safe by default: repository writes are disabled
unless `INFERFUND_ENABLE_WRITES=true` is set *and* separate sandbox
credentials are provided. See `docs/deployment.md`.

## Testing

`npm test` runs the full Vitest suite against a fake GitHub service — no live
GitHub mutations, no database, no secrets required. Suites cover: stateless
OAuth (PKCE, resource binding, expiry, forgery), ownership enforcement,
branch naming, append-only path policy, manifest validation, policy-validator
diff fixtures, attestation-driven frontier ranking, rate limiting,
idempotency, and full MCP tool flows through the real HTTP handler.

## Contributing / license

Contributions become part of a public append-only research archive attributed
to your GitHub identity. License choice for code and mathematical artifacts
is currently **unresolved** — see `docs/license-todo.md` (launch blocker).

## Documentation

- `docs/architecture.md` — system design and decisions
- `docs/auth.md` — OAuth 2.1 / MCP authorization flow (stateless)
- `docs/github-security.md` — repository topology, rulesets, Actions hardening
- `docs/progress-format.md` — the `progress` branch data format
- `docs/deployment.md` — production deployment checklist
