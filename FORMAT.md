# InferFund progress format (v1)

## Layout

    attempts/<problem-key>/<attempt-id>/
      manifest.json     # schema_version 1, see src/lib/attempts/manifest.ts
      README.md         # human-readable research report
      artifacts/        # supporting evidence (text)
      lean/             # Lean 4 sources (.lean only)
    attestations/
      <attestation-id>.json

## Invariants

- A pull request may only ADD files inside exactly one attempt directory.
- Attempt IDs are UUIDv7 and match the source branch:
  attempt/u<GITHUB_NUMERIC_ID>/<PROBLEM_KEY>/<ATTEMPT_ID>
- manifest.json must validate against the schema on `main` and record
  base_progress_sha (the progress HEAD the attempt branched from),
  the problem statement hash, and the author's numeric GitHub ID.
