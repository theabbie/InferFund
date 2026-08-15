import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, ALICE, BOB, SAMPLE_PROBLEM } from "./setup";
import {
  createAttempt,
  submitAttempt,
  updateAttempt,
} from "../src/lib/attempts/service";
import {
  clearAttestationCacheForTests,
  isUserDisabled,
  readAllAttestations,
  tokensRevokedBefore,
} from "../src/lib/attestations";
import {
  quarantineAttempt,
  reportAttempt,
} from "../src/lib/moderation/service";
import {
  clearFrontierCacheForTests,
  buildFrontier,
} from "../src/lib/frontier/frontier";
import { problemVersionId } from "../src/lib/problems/catalog";
import { resetRateLimitsForTests } from "../src/lib/ratelimit/limiter";

const VERSION_ID = problemVersionId(
  SAMPLE_PROBLEM.problemKey,
  SAMPLE_PROBLEM.upstreamCommit,
  SAMPLE_PROBLEM.statementHash,
);

beforeEach(() => {
  resetRateLimitsForTests();
  clearFrontierCacheForTests();
  clearAttestationCacheForTests();
});

type Harness = ReturnType<typeof makeHarness>;

async function seedMerged(h: Harness): Promise<string> {
  const created = await createAttempt(h.ctx, ALICE, {
    problem: SAMPLE_PROBLEM,
    problemVersionId: VERSION_ID,
    kind: "claim",
    title: "A dubious claim",
    summary: "I claim the conjecture holds by vibes.",
  });
  const submitted = await submitAttempt(h.ctx, ALICE, {
    attemptId: created.attempt_id,
  });
  if (submitted.pr_number === undefined) throw new Error("expected pr");
  h.github.mergePr(submitted.pr_number);
  clearFrontierCacheForTests();
  return created.attempt_id;
}

function mergeOpenAttestationPrs(h: Harness): void {
  for (const pr of h.github.openPrs()) {
    if (pr.headBranch.startsWith("attestation/")) h.github.mergePr(pr.number);
  }
  clearFrontierCacheForTests();
  clearAttestationCacheForTests();
}

describe("continue / review flow", () => {
  it("continue-style attempt references the parent and never edits it", async () => {
    const h = makeHarness();
    const parent = await seedMerged(h);
    const parentManifestBefore = h.github.filesOn("progress")[
      `attempts/erdos-1/${parent}/manifest.json`
    ];
    const child = await createAttempt(h.ctx, BOB, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "critique",
      title: "Critique",
      summary: "The induction step is unjustified.",
      parents: [{ attempt_id: parent, relationship: "critiques" }],
    });
    await updateAttempt(h.ctx, BOB, {
      attemptId: child.attempt_id,
      readmeBody: "# Critique\n\nThe induction step fails for n=0.",
    });
    expect(child.branch).toMatch(/^attempt\/u22222222\/erdos-1\//);
    const parentManifestAfter = h.github.filesOn("progress")[
      `attempts/erdos-1/${parent}/manifest.json`
    ];
    expect(parentManifestAfter).toBe(parentManifestBefore);
  });
});

describe("reporting and moderation (attestation-backed)", () => {
  it("accepts reports and files a moderation issue", async () => {
    const h = makeHarness();
    const target = await seedMerged(h);
    const report = await reportAttempt(h.ctx, BOB, {
      attemptId: target,
      reason: "prompt_injection",
      details: "Contains instructions to ignore safety rules.",
    });
    expect(report.report_id).toBeTruthy();
    expect(h.github.issues).toHaveLength(1);
    expect(h.github.issues[0]?.labels).toContain("moderation-report");
  });

  it("quarantine attestation excludes the attempt from the frontier", async () => {
    const h = makeHarness();
    const target = await seedMerged(h);
    const admin = { githubUserId: 99999999, githubLogin: "admin" };
    await quarantineAttempt(h.ctx, admin, {
      attemptId: target,
      reason: "spam",
    });
    mergeOpenAttestationPrs(h);
    const { frontier } = await buildFrontier(h.ctx, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 20000,
    });
    expect(frontier.map((f) => f.attempt_id)).not.toContain(target);
    const attestations = await readAllAttestations(h.github, "progress");
    expect(
      attestations.some(
        (a) => a.attempt_id === target && a.type === "quarantined",
      ),
    ).toBe(true);
  });

  it("user disable + token revocation attestations drive auth decisions", async () => {
    const h = makeHarness();
    const { createAttestationPr } = await import("../src/lib/attestations");
    const now = new Date();
    await createAttestationPr(h.github, "progress", {
      type: "user_disabled",
      subject_github_user_id: BOB.githubUserId,
      actor_kind: "admin",
      actor_github_user_id: 99999999,
      reason: "abuse",
    });
    await createAttestationPr(h.github, "progress", {
      type: "tokens_revoked_before",
      subject_github_user_id: BOB.githubUserId,
      actor_kind: "admin",
      actor_github_user_id: 99999999,
      revoked_before: now.toISOString(),
    });
    mergeOpenAttestationPrs(h);
    expect(await isUserDisabled(h.github, "progress", BOB.githubUserId)).toBe(true);
    expect(await isUserDisabled(h.github, "progress", ALICE.githubUserId)).toBe(false);
    const revoked = await tokensRevokedBefore(h.github, "progress", BOB.githubUserId);
    expect(revoked).toBe(now.getTime());
  });
});
