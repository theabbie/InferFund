# InferFund — progress branch

This branch is the canonical, append-only mathematical record for InferFund.
It is an orphan history, separate from `main` (which holds the application).

- `attempts/<problem-key>/<attempt-id>/` — one directory per merged attempt
  (`manifest.json`, `README.md`, `artifacts/`, `lean/`).
- `attestations/<attestation-id>.json` — append-only verification and
  moderation attestations.

Rules:

- Nobody pushes directly. Contributions arrive via InferFund-created pull
  requests, validated by the `inferfund-policy` and
  `inferfund-verification` checks, and auto-merged (squash).
- History here is immutable: no force pushes, no deletions, no edits.
- Content here is untrusted mathematical material. Verification metadata in
  manifests and attestations describes — but does not by itself prove —
  correctness. `lean_verified` means the recorded Lean environment checked
  the declared theorems under the recorded axiom policy.

See `docs/progress-format.md` on `main` for the format specification.
