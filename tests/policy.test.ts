import { describe, expect, it } from "vitest";
import {
  validatePullRequestPolicy,
  type DiffFile,
  type PolicyInput,
} from "../verifier/policy";
import { newAttemptId } from "../src/lib/ids";

function makeManifest(overrides: Record<string, unknown> = {}): string {
  const attemptId = newAttemptId();
  return JSON.stringify({
    schema_version: 1,
    attempt_id: attemptId,
    problem: {
      source: "formal-conjectures",
      problem_key: "erdos-1",
      problem_version_id: "erdos-1@b33d8678a281#abc",
      upstream_ref: "google-deepmind/formal-conjectures@b33d8678",
      statement_hash:
        "sha256:d6ef3e37ab317fda531daf2c54d57f875071b562e20edc271a3e2c21da305166",
    },
    author: { github_user_id: 11111111, github_login: "alice" },
    created_at: new Date().toISOString(),
    base_progress_sha: "a".repeat(40),
    kind: "exploration",
    title: "A test attempt",
    summary: "Investigating sum-distinct sets.",
    parents: [],
    claims: [],
    artifacts: [],
    declared_lean_theorems: [],
    solves_target: false,
    agent_metadata: {},
    research_sources: [],
    ...overrides,
  });
}

function makeInput(
  manifestContent: string,
  files: DiffFile[],
  overrides: Partial<PolicyInput> = {},
): PolicyInput {
  const manifest = JSON.parse(manifestContent) as {
    attempt_id: string;
    problem: { problem_key: string };
    author: { github_user_id: number };
  };
  return {
    prBaseBranch: "progress",
    headBranch: `attempt/u11111111/erdos-1/${manifest.attempt_id}`,
    headSha: "b".repeat(40),
    files: [
      {
        filename: `attempts/erdos-1/${manifest.attempt_id}/manifest.json`,
        status: "added",
        additions: 10,
        deletions: 0,
        content: manifestContent,
      },
      ...files,
    ],
    expectedProblemKey: "erdos-1",
    expectedAttemptId: manifest.attempt_id,
    expectedAuthorGithubUserId: 11111111,
    expectedBaseProgressSha: "a".repeat(40),
    prAuthorGithubId: 11111111,
    prAuthorIsBot: false,
    maxFilesPerAttempt: 20,
    maxAttemptBytes: 1024 * 1024,
    knownParentAttemptIds: [],
    validProblemStatementHash:
      "sha256:d6ef3e37ab317fda531daf2c54d57f875071b562e20edc271a3e2c21da305166",
    ...overrides,
  };
}

describe("append-only PR policy", () => {
  it("accepts a valid new attempt directory", () => {
    const manifest = makeManifest();
    const parsed = JSON.parse(manifest) as { attempt_id: string };
    const result = validatePullRequestPolicy(
      makeInput(manifest, [
        {
          filename: `attempts/erdos-1/${parsed.attempt_id}/README.md`,
          status: "added",
          additions: 40,
          deletions: 0,
        },
      ]),
    );
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects edits to an existing attempt", () => {
    const manifest = makeManifest();
    const result = validatePullRequestPolicy(
      makeInput(manifest, [
        {
          filename: "attempts/erdos-1/some-old-attempt/manifest.json",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/status "modified"/);
  });

  it("rejects deletions", () => {
    const manifest = makeManifest();
    const parsed = JSON.parse(manifest) as { attempt_id: string };
    const result = validatePullRequestPolicy(
      makeInput(manifest, [
        {
          filename: `attempts/erdos-1/${parsed.attempt_id}/README.md`,
          status: "removed",
          additions: 0,
          deletions: 40,
        },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects files touching two attempt directories", () => {
    const manifest = makeManifest();
    const result = validatePullRequestPolicy(
      makeInput(manifest, [
        {
          filename: "attempts/erdos-2/other-id/README.md",
          status: "added",
          additions: 1,
          deletions: 0,
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/outside the attempt directory/);
  });

  it("rejects workflow additions", () => {
    const manifest = makeManifest();
    const result = validatePullRequestPolicy(
      makeInput(manifest, [
        {
          filename: ".github/workflows/evil.yml",
          status: "added",
          additions: 5,
          deletions: 0,
        },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong PR base branch", () => {
    const manifest = makeManifest();
    const result = validatePullRequestPolicy(
      makeInput(manifest, [], { prBaseBranch: "main" }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/base branch/);
  });

  it("rejects author mismatch", () => {
    const manifest = makeManifest({
      author: { github_user_id: 22222222, github_login: "mallory" },
    });
    const result = validatePullRequestPolicy(makeInput(manifest, []));
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/author github_user_id/);
  });

  it("rejects statement hash mismatch", () => {
    const manifest = makeManifest({
      problem: {
        source: "formal-conjectures",
        problem_key: "erdos-1",
        problem_version_id: "x",
        upstream_ref: "r",
        statement_hash: "sha256:" + "0".repeat(64),
      },
    });
    const result = validatePullRequestPolicy(makeInput(manifest, []));
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/statement_hash/);
  });

  it("rejects nonexistent parents", () => {
    const manifest = makeManifest({
      parents: [
        { attempt_id: newAttemptId(), relationship: "extends" },
      ],
    });
    const result = validatePullRequestPolicy(makeInput(manifest, []));
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/not a known merged attempt/);
  });

  it("rejects PRs whose author is not the branch owner", () => {
    const manifest = makeManifest();
    const result = validatePullRequestPolicy(
      makeInput(manifest, [], { prAuthorGithubId: 22222222 }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/PR author does not match/);
  });

  it("allows bot-authored PRs (service-mediated flow) with coherent branch+manifest", () => {
    const manifest = makeManifest();
    const result = validatePullRequestPolicy(
      makeInput(manifest, [], { prAuthorGithubId: 0, prAuthorIsBot: true }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects secret-looking content", () => {
    const manifest = makeManifest();
    const parsed = JSON.parse(manifest) as { attempt_id: string };
    const result = validatePullRequestPolicy(
      makeInput(manifest, [
        {
          filename: `attempts/erdos-1/${parsed.attempt_id}/artifacts/notes.md`,
          status: "added",
          additions: 1,
          deletions: 0,
          content: "oops my token ghp_" + "A".repeat(36),
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/personal access token/);
  });
});
