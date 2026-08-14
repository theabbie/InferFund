# InferFund architecture

_Status: V1. This file records consequential design decisions (and why)._

## Overview

InferFund is a remote MCP server deployed on Vercel with two planes:

- **Control plane — PostgreSQL** (Drizzle ORM): users, OAuth clients/codes/
  tokens, collaboration state, attempts, attempt edges, PRs, verification
  runs, attestations, moderation events, audit log, rate-limit buckets,
  idempotency keys.
- **Artifact plane — GitHub**: the orphan `progress` branch holds the
  canonical, immutable mathematical record (`attempts/…`, `attestations/…`).
  `main` holds all application code and all GitHub Actions workflows.

Rule (spec §80): Git is canonical for merged mathematical artifacts; the DB is
authoritative for auth, ownership of *pending* attempts, rate limits and
workflow state. On divergence, never silently rewrite Git; run
`npm run reconcile`.

## Key decisions

### 1. MCP transport: `mcp-handler` v2, stateless Streamable HTTP

The current MCP spec (2026-07-28) is served natively; 2025-era Streamable HTTP
clients are served by the SDK's stateless fallback from the same handler.
No SSE, no Redis, no sessions — fully serverless-safe.

### 2. Authorization: first-party OAuth 2.1 authorization server

MCP authorization and GitHub identity are separate concerns:

```
MCP client ──OAuth 2.1 (PKCE, resource-bound)──▶ InferFund AS
InferFund AS ──GitHub OAuth (read:user)────────▶ GitHub
```

- PKCE S256 mandatory for all clients.
- RFC 8707 `resource` required and bound to issued tokens; the MCP endpoint
  rejects tokens whose resource doesn't match `INFERFUND_MCP_RESOURCE_URL`.
- Client registration: **CIMD** (client_id = HTTPS URL hosting a metadata
  document) for current-spec clients, plus an **RFC 7591 DCR** endpoint
  (`/oauth/register`) for 2025-era clients. CIMD documents are fetched with
  strict limits (5s timeout, 16 KiB, no redirects, `client_id` must equal the
  URL, redirect URIs must be https or loopback http).
- Opaque tokens (`ifu_`/`ifr_` prefixes), HMAC-SHA256 hashed at rest with
  `INFERFUND_TOKEN_SECRET`. Access tokens 1h, refresh tokens 30d with
  rotation; replay of a rotated refresh token revokes the successor chain.
- Authorization codes: 5 min TTL, single-use, bound to client + redirect_uri
  + resource + PKCE challenge.
- Scopes: `inferfund:read`, `inferfund:contribute`, `inferfund:admin`
  (admin is granted only to `INFERFUND_ADMIN_GITHUB_IDS`, never
  client-self-assigned).
- The upstream GitHub leg uses scope `read:user` only. Repository writes are
  performed by the GitHub App service identity, never the user's token.

### 3. GitHub writes: App-mediated, server-generated branches

Contributors never receive repository write access. At first login InferFund
adds them as a **triage** collaborator (read-level UX), which is not required
for any InferFund operation. All mutations (branch creation, commits, PRs,
auto-merge) are performed by the GitHub App installation token after
server-side authorization checks against the numeric `github_user_id`.

Branch names are allocated by the server:
`attempt/u<GITHUB_NUMERIC_ID>/<PROBLEM_KEY>/<UUIDV7>`, created from the exact
`progress` HEAD SHA at creation time, recorded in DB + manifest. Collisions
regenerate the UUID; branches are never force-pushed.

### 4. Verification: `pull_request_target` sourced from `main`

Since GitHub's 2025-11-07 change, `pull_request_target` workflows are **always
sourced from the default branch** regardless of the PR's base branch. This
lets workflows live only on `main` while validating PRs that target
`progress`. Job separation:

- `inferfund-policy` (checks:write): never checks out PR content. Reads the
  diff via the API and validates it as *data*: base == progress, branch
  naming, adds-only inside one attempt directory, no `.github`/symlinks/
  submodules/LFS/secrets/oversize, manifest schema, author/problem/parent
  coherence, statement-hash match against the pinned catalog.
- `lean-execution` (contents:read only, no secrets): checks out the PR head
  SHA with `persist-credentials: false`, copies only approved `.lean` files
  into a pinned Formal Conjectures workspace, compiles, then runs a **separate
  lean process** that imports the compiled oleans and prints axioms of the
  declared theorems (so contributor macros cannot forge axiom output).
  `sorry`/`admit`/`sorryAx` are rejected; axioms must be within
  `verifier/config.json`'s allowlist; declared theorems must exist; when
  `solves_target` is claimed, a generated `inferfund_target_check` theorem
  must typecheck against the exact pinned target statement.
- `inferfund-verification` (checks:write): strictly schema-validates the
  result artifact and re-checks attempt-id/SHA binding before publishing the
  check. It executes nothing untrusted.

Required checks on `progress` (`inferfund-policy`, `inferfund-verification`)
gate GitHub auto-merge (squash). A green policy check means *structurally
valid*, never *correct*.

Residual risk (documented, accepted for V1): the Lean job runs on an ephemeral
GitHub-hosted runner with network available (needed for `lake exe cache get`
on cache miss) and a `contents:read` token only. Contributor Lean macros
execute during elaboration in that sandbox; they can access nothing secret
and nothing durable.

### 5. Problem catalog: pinned, versioned, file-based + DB cache

`config/formal-conjectures.json` pins the upstream commit (currently
`b33d8678a28118c95d8d4f60b11faaf39ccff1e6`, Lean `leanprover/lean4:v4.27.0`).
`npm run sync:problems` extracts every `@[category …]`-annotated declaration
(title, doc comment, formal statement, module, AMS tags, status) into the
committed `data/problems.json`. MCP reads use the file (works without a DB
row); writes materialize the problem + pinned version into the DB lazily.
`statement_hash` = sha256 of the whitespace-normalized statement. Upstream
statement changes create new `problem_versions` rows; old attempts stay bound
to their original version.

### 6. Frontier: deterministic, evidence-ranked

`get_frontier` buckets merged attempts: VERIFIED (lean_verified) >
REPRODUCED > OPEN_SUBGOAL (lemma/reduction) > BLOCKED (refutation/
counterexample) > DISPUTED > REFUTED > UNVERIFIED; ties broken by
referenced-by count then recency. Quarantined content is excluded by default.
Output is `max_chars`-budgeted and every entry carries
`trust: "untrusted_contributor_content"`.

### 7. Attestations in V1

Verification and moderation outcomes are stored as append-only attestation
rows in Postgres and surfaced through MCP tools. Writing
`attestations/*.json` bot PRs to `progress` is a documented follow-up
(requires the policy validator to allow attestation-only PRs from a service
branch pattern); the Git attempt record itself remains the immutable artifact.

### 8. Preview safety

When `VERCEL_ENV=preview` (or any non-production env) and
`INFERFUND_ENABLE_WRITES` is not explicitly `true`, every GitHub mutation is
refused with `FORBIDDEN`. Preview deployments therefore cannot mutate the
production repository even if given production secrets by mistake.

## Module map

```
src/lib/
  config.ts           env validation (Zod), preview-safety, admin IDs
  errors.ts           typed error codes (spec §76)
  ids.ts              UUIDv7, branch names, problem keys, hashing
  db/                 Drizzle schema, client, migrations
  auth/               tokens/PKCE, CIMD+DCR clients, authorize flow, GitHub leg
  users/              user upsert, collaborator management
  attempts/           manifest schema, path policy, lifecycle services
  problems/           FC extraction, catalog access/search
  frontier/           evidence-ranked frontier
  ratelimit/          DB-bucket rate limiter + central limits
  moderation/         reports, quarantine
  audit/              sanitized structured audit log
  mcp/                tool registrations, trust-labeled responses, directive
verifier/             CI-side policy validator, Lean orchestration, config
scripts/              sync:problems, db:migrate, setup:github, reconcile,
                      configure-rulesets
```
