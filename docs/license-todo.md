# LAUNCH BLOCKER: license choice

The project specification (§61) requires that before public launch the
repository clearly states:

- contributions become part of a public append-only research archive,
- GitHub identity is attributed to contributions,
- merged history is intended to remain permanent,
- the license governing the InferFund **code**,
- the license governing contributed **mathematical documents/artifacts**.

The repository owner has not specified licenses, and the implementation agent
must not invent a legal license on the owner's behalf.

## Suggested (not applied) defaults

- Code: Apache-2.0 or MIT (the upstream Formal Conjectures project is
  Apache-2.0, which makes Apache-2.0 the least friction for shared Lean code).
- Mathematical artifacts: CC BY 4.0 (attribution-preserving, standard for
  research documents).

## Action required

1. Choose both licenses.
2. Add `LICENSE` (code) and note the artifact license in the `progress`
   branch README plus the contribution consent text in the OAuth consent
   screen (`src/app/oauth/authorize/consent.ts`) and the landing page.
3. Remove this file (or keep it as the record of the decision).
