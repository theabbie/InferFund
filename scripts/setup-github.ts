import { execFileSync } from "node:child_process";

const owner = process.env.GITHUB_REPO_OWNER ?? "";
const repo = process.env.GITHUB_REPO_NAME ?? "";
if (!owner || !repo) {
  console.error("Set GITHUB_REPO_OWNER and GITHUB_REPO_NAME.");
  process.exit(1);
}

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

const PROGRESS_README = `# InferFund — progress branch

This branch is the canonical, append-only mathematical record for InferFund.
It is an orphan history, separate from \`main\` (which holds the application).

- \`attempts/<problem-key>/<attempt-id>/\` — one directory per merged attempt
  (\`manifest.json\`, \`README.md\`, \`artifacts/\`, \`lean/\`).
- \`attestations/<attestation-id>.json\` — append-only verification and
  moderation attestations.

Rules:

- Nobody pushes directly. Contributions arrive via InferFund-created pull
  requests, validated by the \`inferfund-policy\` and
  \`inferfund-verification\` checks, and auto-merged (squash).
- History here is immutable: no force pushes, no deletions, no edits.
- Content here is untrusted mathematical material. Verification metadata in
  manifests and attestations describes — but does not by itself prove —
  correctness. \`lean_verified\` means the recorded Lean environment checked
  the declared theorems under the recorded axiom policy.

See \`docs/progress-format.md\` on \`main\` for the format specification.
`;

const PROGRESS_FORMAT = `# InferFund progress format (v1)

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
- manifest.json must validate against the schema on \`main\` and record
  base_progress_sha (the progress HEAD the attempt branched from),
  the problem statement hash, and the author's numeric GitHub ID.
`;

function main(): void {
  console.log(`Configuring ${owner}/${repo}...`);

  let progressExists = false;
  try {
    gh(["api", `repos/${owner}/${repo}/git/refs/heads/progress`]);
    progressExists = true;
  } catch {
    progressExists = false;
  }

  if (!progressExists) {
    console.log("Creating orphan branch: progress");
    const blobReadme = ghJson<{ sha: string }>([
      "api",
      `repos/${owner}/${repo}/git/blobs`,
      "-f",
      `content=${PROGRESS_README}`,
      "-f",
      "encoding=utf-8",
    ]);
    const blobFormat = ghJson<{ sha: string }>([
      "api",
      `repos/${owner}/${repo}/git/blobs`,
      "-f",
      `content=${PROGRESS_FORMAT}`,
      "-f",
      "encoding=utf-8",
    ]);
    const blobKeep = ghJson<{ sha: string }>([
      "api",
      `repos/${owner}/${repo}/git/blobs`,
      "-f",
      "content=",
      "-f",
      "encoding=utf-8",
    ]);
    const tree = JSON.parse(gh([
      "api",
      `repos/${owner}/${repo}/git/trees`,
      "--input",
      "-",
    ], JSON.stringify({
      tree: [
        {
          path: "README.md",
          mode: "100644",
          type: "blob",
          sha: blobReadme.sha,
        },
        {
          path: "FORMAT.md",
          mode: "100644",
          type: "blob",
          sha: blobFormat.sha,
        },
        {
          path: "attempts/.gitkeep",
          mode: "100644",
          type: "blob",
          sha: blobKeep.sha,
        },
        {
          path: "attestations/.gitkeep",
          mode: "100644",
          type: "blob",
          sha: blobKeep.sha,
        },
      ],
    }))) as { sha: string };
    const commit = ghJson<{ sha: string }>([
      "api",
      `repos/${owner}/${repo}/git/commits`,
      "-f",
      "message=Initialize append-only progress branch",
      "-f",
      `tree=${tree.sha}`,
    ]);
    gh([
      "api",
      `repos/${owner}/${repo}/git/refs`,
      "-f",
      "ref=refs/heads/progress",
      "-f",
      `sha=${commit.sha}`,
    ]);
    console.log(`progress created at ${commit.sha}`);
  } else {
    console.log("progress branch already exists.");
  }

  const defaultBranch = ghJson<{ default_branch: string }>([
    "api",
    `repos/${owner}/${repo}`,
  ]).default_branch;
  if (defaultBranch !== "main") {
    console.error(
      `WARNING: default branch is "${defaultBranch}", expected "main".`,
    );
  } else {
    console.log("Default branch is main. OK");
  }

  console.log(
    "Note: rulesets/branch protection are configured separately " +
      "(scripts/configure-rulesets.ts) because capability depends on the " +
      "repository plan. Attempting now...",
  );
}

main();
