# InferFund architecture

_Status: V1. This file records consequential design decisions (and why)._

## Overview

InferFund is a remote MCP server deployed on Vercel with **zero databases**.
It is fully stateless; all durable state lives in Git and GitHub metadata:

- **Artifact plane — GitHub**: the orphan `progress` branch holds the
  canonical, immutable mathematical record (`attempts/…`, `attestations/…`).
  `main` holds all application code and all GitHub Actions workflows.
- **Derived control plane — GitHub metadata**: attempt status is derived from
  branch existence, open/merged PRs, and the `progress` tree. Rate limits are
  in-memory per instance, reinforced by GitHub-derived quotas (branch counts,
  PR creation counts). Audit is structured JSON logs.
- **Auth plane — signed stateless tokens**: OAuth authorization codes,
  upstream states, access/refresh tokens, and DCR client registrations are
  HMAC-signed self-contained payloads with expiry. Nothing is stored.

Decision (owner-directed, supersedes the original Postgres plan): no database
anywhere. Rationale: every piece of state the DB held is either derivable
from Git + GitHub (attempts, ownership, verification overlays, quotas) or
short-lived OAuth transaction data that signed tokens carry more safely and
simply. Trade-offs accepted and documented: (1) access tokens are not
individually revocable before their 1h expiry — admin revocation works via
`tokens_revoked_before` attestation overlays checked at auth time; (2)
authorization codes are PKCE-bound and short-lived but not single-use; (3)
in-memory rate limits are per-serverless-instance (porous) while the *hard*
quotas (open attempts, daily creations) are GitHub-derived and global.

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
  URL, redirect URIs must be https or loopback http) and cached in memory for
  5 minutes. DCR client ids are self-describing signed payloads — no
  server-side registry.
- Stateless signed tokens (`ifa_`/`ifr_` prefixes): HMAC-SHA256 over a JSON
  payload {sub, login, cid, scp, res, iat, exp, nonce} with
  `INFERFUND_TOKEN_SECRET`. Access tokens 1h, refresh tokens 30d. Refresh
  re-issues a fresh pair; emergency global revocation = rotate the secret;
  per-user revocation = `tokens_revoked_before` attestation checked at auth.
- Authorization codes (`ifc_`): 5 min TTL, PKCE-bound, bound to client +
  redirect_uri + resource; self-contained signed payloads.
- Upstream OAuth state (`ifs_`): signed with `INFERFUND_SESSION_SECRET`,
  10 min TTL, self-contained.
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

### 7. Attestations (fully Git-native)

Verification and moderation outcomes are append-only
`attestations/**/*.json` files on `progress`, written via service-created
`attestation/<UUIDV7>` PRs (the policy validator accepts exactly that shape:
adds-only JSON under `attestations/`). On every contribution merge, the
webhook reads the check runs for the merged head SHA and files the
verification attestation. Quarantine, user-disable, and token-revocation
overlays use the same mechanism. Current state = immutable attempts +
immutable attestations, derived at read time with a 60s tree-SHA-keyed
in-memory cache.

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
  auth/               stateless signed tokens, PKCE, CIMD+DCR, GitHub leg
  users/              collaborator management (GitHub is the store)
  attempts/           manifest schema, path policy, Git-backed lifecycle
  attestations.ts     append-only attestation overlays on progress
  problems/           FC extraction, catalog access/search
  frontier/           evidence-ranked frontier (Git tree + attestations)
  ratelimit/          in-memory buckets + GitHub-derived quotas
  moderation/         reports (issues), quarantine (attestations)
  audit/              sanitized structured JSON logging
  mcp/                tool registrations, trust-labeled responses, directive
verifier/             CI-side policy validator, Lean orchestration, config
scripts/              sync:problems, setup:github, configure:rulesets,
                      reconcile
```
