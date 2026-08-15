import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, ALICE, BOB, SAMPLE_PROBLEM } from "./setup";
import {
  createAttempt,
  submitAttempt,
  findAttemptById,
} from "../src/lib/attempts/service";
import {
  buildFrontier,
  clearFrontierCacheForTests,
} from "../src/lib/frontier/frontier";
import {
  clearAttestationCacheForTests,
  createAttestationPr,
} from "../src/lib/attestations";
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

async function mergedAttempt(
  h: Harness,
  actor: typeof ALICE,
  title: string,
  kind: "lemma" | "exploration" | "refutation" | "proof" | "reproduction",
  parents?: Array<{ attempt_id: string; relationship: "extends" | "reproduces" | "refutes" | "critiques" }>,
): Promise<string> {
  const created = await createAttempt(h.ctx, actor, {
    problem: SAMPLE_PROBLEM,
    problemVersionId: VERSION_ID,
    kind,
    title,
    summary: `Summary for ${title} with enough characters.`,
    parents,
  });
  const submitted = await submitAttempt(h.ctx, actor, {
    attemptId: created.attempt_id,
  });
  if (submitted.pr_number === undefined) throw new Error("expected pr");
  h.github.mergePr(submitted.pr_number);
  clearFrontierCacheForTests();
  clearAttestationCacheForTests();
  return created.attempt_id;
}

describe("frontier generation (Git-backed)", () => {
  it("ranks lean-verified above unverified and excludes quarantined", async () => {
    const h = makeHarness();
    const unverified = await mergedAttempt(h, ALICE, "Speculative idea", "exploration");
    const verified = await mergedAttempt(h, BOB, "Verified lemma", "lemma");
    const spam = await mergedAttempt(h, BOB, "Spam", "exploration");

    await createAttestationPr(h.github, "progress", {
      type: "lean_verified",
      attempt_id: verified,
      actor_kind: "verifier",
    }).then(async (r) => {
      const prs = h.github.openPrs();
      const pr = prs.find((p) => p.headBranch === `attestation/${r.attestation_id}`);
      if (pr) h.github.mergePr(pr.number);
    });
    const q = await createAttestationPr(h.github, "progress", {
      type: "quarantined",
      attempt_id: spam,
      actor_kind: "admin",
      actor_github_user_id: 99999999,
      reason: "spam",
    });
    const qpr = h.github.openPrs().find(
      (p) => p.headBranch === `attestation/${q.attestation_id}`,
    );
    if (qpr) h.github.mergePr(qpr.number);
    clearFrontierCacheForTests();
    clearAttestationCacheForTests();

    const { frontier } = await buildFrontier(h.ctx, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 20000,
    });
    const ids = frontier.map((f) => f.attempt_id);
    expect(ids).toContain(verified);
    expect(ids).toContain(unverified);
    expect(ids).not.toContain(spam);
    expect(ids.indexOf(verified)).toBeLessThan(ids.indexOf(unverified));
    expect(
      frontier.find((f) => f.attempt_id === verified)?.bucket,
    ).toBe("VERIFIED");
  });

  it("derives refuted status from refuting edges", async () => {
    const h = makeHarness();
    const bad = await mergedAttempt(h, ALICE, "Wrong approach", "exploration");
    await mergedAttempt(h, BOB, "Refutation of the wrong approach", "refutation", [
      { attempt_id: bad, relationship: "refutes" },
    ]);
    const { frontier } = await buildFrontier(h.ctx, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 20000,
    });
    const entry = frontier.find((f) => f.attempt_id === bad);
    expect(entry?.bucket).toBe("REFUTED");
  });

  it("respects the max_chars budget", async () => {
    const h = makeHarness();
    h.ctx.maxOpenAttempts = 50;
    h.ctx.maxAttemptsPerDay = 50;
    h.ctx.maxSubmissionsPerDay = 50;
    for (let i = 0; i < 8; i++) {
      await mergedAttempt(h, ALICE, `Attempt number ${i}`, "exploration");
    }
    const { frontier, truncated } = await buildFrontier(h.ctx, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 1500,
    });
    expect(frontier.length).toBeLessThan(8);
    expect(truncated).toBe(true);
  });

  it("parent edges are recorded in manifests and reconstructed", async () => {
    const h = makeHarness();
    const parent = await mergedAttempt(h, ALICE, "Base result", "lemma");
    const child = await mergedAttempt(h, BOB, "Child result", "lemma", [
      { attempt_id: parent, relationship: "extends" },
    ]);
    const record = await findAttemptById(h.ctx, child);
    expect(record?.parents).toEqual([
      { attempt_id: parent, relationship: "extends" },
    ]);
  });

  it("rejects parents that are not merged", async () => {
    const h = makeHarness();
    const pending = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "lemma",
      title: "Pending parent",
      summary: "Not merged yet.",
    });
    await expect(
      createAttempt(h.ctx, BOB, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "lemma",
        title: "Child of pending",
        parents: [{ attempt_id: pending.attempt_id, relationship: "extends" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects nonexistent parents", async () => {
    const h = makeHarness();
    await expect(
      createAttempt(h.ctx, ALICE, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "lemma",
        title: "Ghost parent",
        parents: [
          {
            attempt_id: "0195e7c0-8e7a-7f82-bfa2-a91338dd7b53",
            relationship: "extends",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });
  });
});
