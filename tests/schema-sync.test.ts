import { describe, expect, it } from "vitest";
import { manifestSchema } from "../src/lib/attempts/manifest";
import { manifestPolicySchema } from "../verifier/policy";

function appKeys(): string[] {
  return Object.keys(manifestSchema.shape).sort();
}
function policyKeys(): string[] {
  return Object.keys(manifestPolicySchema.shape).sort();
}

describe("manifest schema sync (app vs CI policy)", () => {
  it("both schemas accept exactly the same top-level keys", () => {
    expect(policyKeys()).toEqual(appKeys());
  });

  it("a full valid manifest passes both", () => {
    const manifest = {
      schema_version: 1,
      attempt_id: "01962d82-1234-7abc-8def-0123456789ab",
      problem: {
        source: "formal-conjectures",
        problem_key: "erdos-1",
        problem_version_id: "erdos-1@b33d8678a281#abc",
        upstream_ref: "google-deepmind/formal-conjectures@b33d8678",
        statement_hash: "sha256:" + "0".repeat(64),
      },
      author: { github_user_id: 17960677, github_login: "theabbie" },
      created_at: new Date().toISOString(),
      base_progress_sha: "a".repeat(40),
      kind: "exploration",
      title: "Sync test",
      summary: "Testing schema parity.",
      parents: [],
      claims: [],
      artifacts: [],
      declared_lean_theorems: [],
      solves_target: false,
      agent_metadata: {},
      research_sources: [],
      client_nonce: "nonce-1234",
    };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifestPolicySchema.safeParse(manifest).success).toBe(true);
  });
});
