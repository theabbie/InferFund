# GitHub security configuration

## Topology

- `main` (default branch): application code, workflows, schemas, catalog.
- `progress` (orphan): mathematical record only. Created by
  `scripts/setup-github.ts`; contains `README.md`, `FORMAT.md`, `attempts/`,
  `attestations/`. No application code, no workflow files.
- `attempt/u<GITHUB_ID>/<PROBLEM_KEY>/<UUIDV7>`: server-generated pending
  attempt branches, always based on the exact `progress` HEAD at creation.

## Actors

- **Contributors**: authenticate via GitHub OAuth (identity only; the login
  token never gets repo permissions). They are added as **write**
  collaborators so they can push their own `attempt/**` branches and open
  PRs to `progress` — normal git flow. Merge-time enforcement (below) makes
  this safe.
- **InferFund GitHub App** (service identity, optional but recommended):
  sends collaborator invitations, performs MCP service-mode writes, and
  files attestation PRs.
- **GITHUB_TOKEN in Actions**: scoped per-job (see workflow file).

## Enforcement layers for contributor pushes

1. `main`: deletion + non-fast-forward blocked; only admins push.
2. `progress`: deletion + non-fast-forward + PR required + required checks
   (`inferfund-policy`, `inferfund-verification`). Verified empirically: even
   the owner's direct push is rejected with "Changes must be made through a
   pull request".
3. `attempt/**`: deletion + non-fast-forward blocked (no history rewrite or
   removal of pending work). Creation/update allowed so collaborators can
   push — merges are gated by CI:
4. CI policy binds three identities on every contribution PR: the PR author's
   numeric GitHub ID, the branch's embedded `u<ID>`, and the manifest's
   `author.github_user_id`. A user can therefore never merge work into
   `progress` under anyone else's identity, and never outside their own
   attempt directory.
5. Branch namespace ruleset: non-admin collaborators can only create
   `attempt/**` branches (creation of arbitrary branches is blocked).
   Repository admins and the App bypass. Empirical note: GitHub does not
   bind the repo *owner* (admin) to every repo-level ruleset rule, so admin
   actions are the trusted escape hatch — treat the admin account as
   privileged infrastructure.

Residual risk (documented, accepted): a malicious collaborator could append
commits to another user's *pending* branch (never rewrite it — ff-only — and
never merge it as their own: the CI author binding fails). Such events are
audit-visible and the offending account can be disabled and quarantined.

## Rulesets (applied by `scripts/configure-rulesets.ts`)

| Ruleset | Refs | Rules | Bypass |
| --- | --- | --- | --- |
| `inferfund-main` | `main` | deletion, non-fast-forward | none |
| `inferfund-progress` | `progress` | deletion, non-fast-forward, PR required, required checks `inferfund-policy` + `inferfund-verification` | none |
| `inferfund-attempt-branches` | `attempt/**` | creation, update, deletion, non-fast-forward | InferFund GitHub App (added when `GITHUB_APP_ID` is set and the script is re-run) |

Notes:

- Until `GITHUB_APP_ID` exists, the attempt-branch ruleset has **no bypass
  actors**, so nobody (including a not-yet-created app) can create attempt
  branches. This fails closed. After creating the App, set `GITHUB_APP_ID`
  and re-run `npm run configure:rulesets` to grant it bypass.
- On personal free plans, repository rulesets on *private* repos may be
  unavailable; the script detects this and reports exact blockers. When the
  repo becomes public (recommended for launch), rulesets apply on the free
  tier.
- Prefer org ownership when possible: organization roles allow more granular
  collaborator control than personal repositories.

## Actions hardening

- Validation runs as `pull_request_target`, which (since GitHub's 2025-11-07
  change) always sources the workflow from the **default branch** — PRs cannot
  modify the workflow that evaluates them, and `progress` needs no workflows.
- The privileged `inferfund-policy` job (`checks: write`) never checks out or
  executes PR content; it reads the diff via the API as data.
- The `lean-execution` job has `permissions: contents: read` and nothing else,
  checks out the PR head with `persist-credentials: false`, and runs the
  pinned Lean toolchain. Lean elaboration can execute contributor macros, so
  this job holds no secrets and no write token; axiom reporting runs in a
  separate `lean` process over the compiled oleans so macro output cannot
  forge it. The publish step (`inferfund-verification`) strictly
  schema-validates the result JSON and re-binds attempt id + head SHA.
- Third-party actions are pinned by SHA (see the workflow file).
- No workflow prints secrets; no secrets are defined for untrusted jobs.

## Threat model coverage (spec §71) — highlights

- **Branch-name injection**: names are server-generated from validated
  components (`u<digits>`, sanitized `[a-z0-9-]` problem key, UUIDv7).
- **Path traversal / Unicode tricks / symlink / submodule / LFS**: rejected in
  `src/lib/attempts/paths.ts` (write time) and re-validated from the git diff
  in `verifier/policy.ts` (merge time). Windows reserved names, control
  characters, NULs, dot segments are all rejected.
- **Malicious Lean**: compiled only in the unprivileged job; `sorry`/`admit`/
  `sorryAx` rejected by source scan *and* axiom inspection; unexpected axioms
  rejected against `verifier/config.json`; timeouts enforced.
- **Irrelevant-but-compiling theorems**: `lean_verified` never implies
  relevance; `solves_target` additionally requires the exact-target check.
- **Spoofed authorship**: author identity comes from the authenticated token
  → numeric GitHub ID; the manifest author is re-checked against the token on
  every write and against the branch name in CI.
- **Direct pushes / history rewrite**: rulesets block creation/update/deletion
  on `attempt/**` for everyone except the App, and require PR + checks +
  linear history on `progress`.
- **Prompt injection**: contributor content is structurally segregated
  (`trust: "untrusted_contributor_content"`) and never interpolated into
  server instructions; tool descriptions carry the warning.
- **Vercel preview with prod secrets**: non-production deployments refuse all
  GitHub writes unless `INFERFUND_ENABLE_WRITES=true` (which should only ever
  be set with a sandbox repo).
- **Accidental secret submission**: policy validation scans added text files
  for private-key headers and common token patterns.
