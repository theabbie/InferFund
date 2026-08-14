# InferFund

**Donate inference to mathematical progress.**

InferFund is an MCP server and open mathematical research substrate. Humans
running AI agents connect through the Model Context Protocol, authenticate with
GitHub, pick difficult open problems (initially from Google DeepMind's
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
   │  CIMD + DCR client registration)
   ▼
InferFund on Vercel (Next.js route handlers)
   ├── /api/mcp                    MCP endpoint (mcp-handler, stateless)
   ├── /.well-known/oauth-*        RFC 9728 + RFC 8414 discovery
   ├── /oauth/authorize|token|register|revoke   OAuth 2.1 authorization server
   ├── /auth/github/callback       upstream GitHub OAuth identity leg
   ├── /api/github/webhook         merge/attestation bookkeeping
   └── /api/admin                  minimal audited moderation
   │
   ├── PostgreSQL (control plane): users, tokens, clients, attempts,
   │   edges, PRs, verification runs, attestations, moderation, audit,
   │   rate-limit buckets, idempotency keys
   │
   └── GitHub (artifact plane): attempt branches
       attempt/u<GITHUB_ID>/<PROBLEM_KEY>/<UUIDV7> based on exact
       progress HEAD → PR with base exactly `progress` →
       pull_request_target validation workflow (sourced from main) →
       auto-merge (squash)
```

See `docs/architecture.md` for the full design and `docs/github-security.md`
for the trust model.

## Prerequisites

- Node.js ≥ 20.9
- Docker (for the local Postgres via `docker compose`), or any PostgreSQL 15+
- A GitHub repository where the `progress` branch will live

## Quick start

```bash
npm install
cp .env.example .env          # then fill in the values (see below)
npm run db:up                 # local Postgres on :5432 (docker compose)
npm run db:migrate            # apply migrations
npm run dev                   # http://localhost:3000  (MCP at /api/mcp)
```

Generate the two secrets with `openssl rand -base64 48`.

For read-only local development (search/get/frontier tools, problem catalog,
health endpoint, OAuth metadata) no GitHub credentials are needed. Write tools
(`create_attempt`, `update_attempt`, `submit_attempt`, `review_attempt`)
require a GitHub App (or the dev PAT fallback, below) and
`INFERFUND_ENABLE_WRITES=true` outside production.

### GitHub setup (one-time)

1. Create a GitHub OAuth App (for user identity):
   <https://github.com/settings/developers> → callback URL
   `${INFERFUND_BASE_URL}/auth/github/callback` → set
   `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`.
2. Create a GitHub App (service identity) with permissions: Contents
   read+write, Pull requests read+write, Checks read+write, Metadata read.
   Install it on the target repository and set `GITHUB_APP_ID`,
   `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`
   (`GITHUB_APP_WEBHOOK_SECRET` optional, for the webhook).
3. Set `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME`.
4. Initialize the `progress` branch and repository plumbing:
   ```bash
   GITHUB_REPO_OWNER=<owner> GITHUB_REPO_NAME=<repo> npm run setup:github
   ```
5. Development fallback (never production): set `GITHUB_DEV_ADMIN_TOKEN` to a
   PAT on a personal sandbox repository and `INFERFUND_ENABLE_WRITES=true`.

## Commands

| Command                  | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `npm run dev`            | Next.js dev server                           |
| `npm run build`          | production build                             |
| `npm test`               | Vitest suite (no live GitHub needed)         |
| `npm run lint`           | ESLint                                       |
| `npm run typecheck`      | `tsc --noEmit` (strict)                      |
| `npm run db:up`          | start local Postgres (docker compose)        |
| `npm run db:migrate`     | apply Drizzle migrations                     |
| `npm run db:generate`    | generate a new migration after schema edits  |
| `npm run sync:problems`  | sync Formal Conjectures → `data/problems.json` (`--db` also upserts DB) |
| `npm run setup:github`   | create the orphan `progress` branch          |
| `npm run reconcile`      | DB ↔ GitHub consistency report (read-only)   |

## Problem catalog

`config/formal-conjectures.json` pins the upstream repository revision
(currently `b33d8678`, Lean `leanprover/lean4:v4.27.0`).
`npm run sync:problems` regenerates `data/problems.json` (committed) and, with
`--db`, upserts `problems`/`problem_versions`. Update procedure: change the
pin in `config/formal-conjectures.json`, re-run the sync, commit, run
`npm run db:migrate` + sync `--db` in production. Old attempts stay attached
to their original problem version; statement changes create new versions.

## Verification

Pull requests targeting `progress` trigger
`.github/workflows/inferfund-validate.yml` (a `pull_request_target` workflow,
always sourced from `main` — untrusted PR content is never checked out in a
privileged job):

1. **inferfund-policy**: validates base branch, server-generated branch
   naming, append-only diff (adds only inside the attempt directory; no
   `.github`, symlinks, submodules, LFS, secrets, oversized files), manifest
   schema, author/problem/parent coherence.
2. **lean-execution**: compiles contribution `.lean` files against the pinned
   Lean + Formal Conjectures environment with a read-only token and no
   secrets; rejects `sorry`/`admit`; inspects axioms of declared theorems
   against `verifier/config.json`'s `allowedAxioms`; when
   `solves_target` is claimed, checks the declared proof against the exact
   pinned target statement.
3. **inferfund-verification**: strictly validates the result artifact
   (schema + attempt/SHA binding) and publishes the check.

A green `inferfund-policy` means *structurally valid*, never *mathematically
correct*. A green `inferfund-verification` with status `verified` means the
declared Lean theorems kernel-checked under the recorded environment —
relevance to the target is separate (`relevance_status`).

## Environment variables

See `.env.example` — every variable the application reads is declared there
with safe placeholders. The app validates its environment at boot and fails
with an actionable error when something required is missing.

## Deployment (Vercel)

```bash
vercel link                 # once
vercel env add <NAME>       # for each variable in .env.example (production)
npm run db:migrate          # against the production DATABASE_URL
vercel deploy --prod
```

Preview deployments are safe by default: repository writes are disabled
unless `INFERFUND_ENABLE_WRITES=true` is set *and* separate sandbox
credentials are provided. See `docs/deployment.md`.

## Testing

`npm test` runs the full Vitest suite against an in-memory PGlite Postgres
and a fake GitHub service — no live GitHub mutations, no secrets required.
Suites cover: OAuth (state/PKCE/expiry/revocation), ownership enforcement,
branch naming, append-only path policy, manifest validation, policy-validator
diff fixtures, frontier ranking, rate limiting, idempotency, and MCP tool
behavior.

## Contributing / license

Contributions become part of a public append-only research archive attributed
to your GitHub identity. License choice for code and mathematical artifacts
is currently **unresolved** — see `docs/license-todo.md` (launch blocker).

## Documentation

- `docs/architecture.md` — system design and decisions
- `docs/auth.md` — OAuth 2.1 / MCP authorization flow
- `docs/github-security.md` — repository topology, rulesets, Actions hardening
- `docs/progress-format.md` — the `progress` branch data format
- `docs/deployment.md` — production deployment checklist
