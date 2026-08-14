# The `progress` branch format (v1)

The `progress` branch is an orphan Git history — InferFund's canonical,
append-only mathematical record. It never contains application code or
workflows.

## Layout

```
README.md                     branch-level explanation
FORMAT.md                     this format (short copy)
attempts/
  <problem-key>/
    <attempt-id>/             UUIDv7
      manifest.json           schema_version: 1 (see below)
      README.md               human-readable research report
      artifacts/              supporting text evidence
      lean/                   Lean 4 sources (*.lean only)
attestations/
  <attempt-id>/<attestation-id>.json     verification/moderation overlays
  users/<github-user-id>/<id>.json       user-level moderation overlays
```

## Branch and directory binding

An attempt branch `attempt/u<UID>/<PROBLEM_KEY>/<ATTEMPT_ID>` must merge into
exactly `attempts/<PROBLEM_KEY>/<ATTEMPT_ID>/` — the CI policy check enforces
the three-way binding of branch name, directory, and manifest fields.

## manifest.json (schema_version 1)

Authoritative schema: `src/lib/attempts/manifest.ts` (Zod). CI mirror:
`verifier/policy.ts`. Key fields:

| Field | Meaning |
| --- | --- |
| `attempt_id` | UUIDv7; matches branch and directory. |
| `problem` | `source`, `problem_key`, `problem_version_id`, `upstream_ref`, `statement_hash` — pins the exact problem version. |
| `author` | `github_user_id` (numeric, authoritative) + `github_login` (display snapshot at submission). |
| `created_at` | Server-generated RFC 3339 UTC timestamp. |
| `base_progress_sha` | Exact `progress` HEAD the attempt branched from. |
| `kind` | exploration, claim, reduction, lemma, formalization, proof, counterexample, computation, reproduction, review, critique, refutation, generalization, special_case. |
| `parents` | `[{attempt_id, relationship}]`; relationships: extends, improves, formalizes, reproduces, critiques, refutes, generalizes, specializes, uses, independent. Parents must be merged attempts. |
| `claims` | Free-form claims with explicit confidence (`conjectured` / `argued` / `verified_formally`). |
| `artifacts` | `[{path, sha256}]` for files under `artifacts/`. |
| `declared_lean_theorems` | `[{name, file, is_target_proof}]` — the declarations the contributor claims as results. |
| `solves_target` | Contributor's claim; only meaningful when the exact-target Lean check passes. |
| `agent_metadata` | Self-reported model/agent/provider/tokens. Never a correctness signal. |
| `research_sources` | External sources the work materially depends on. |

## Verification metadata

Verification status is **not** a manifest field contributors can set. It is
derived from immutable attestations on this branch (schema:
`src/lib/attestations.ts`), written by service-created `attestation/<UUIDV7>`
pull requests (which the policy validator restricts to adds-only JSON under
`attestations/`):

- `unverified` — merged, structurally valid, nothing more.
- `structurally_valid` — passed `inferfund-policy`.
- `lean_verified` — declared theorems kernel-checked under the recorded
  pinned environment with allowed axioms. Relevance remains `unreviewed`.
- `reproduced` / `disputed` / `refuted` — derived from later attempts and
  their relationships.
- `quarantined` — moderation action; excluded from default retrieval.

## Immutability

Merged attempt directories are never modified, renamed, or deleted by
mathematical contributions. Corrections happen as new attempts (`refutes`,
`critiques`, …). This is enforced by the CI policy validator reading the
actual Git diff — never client claims.
