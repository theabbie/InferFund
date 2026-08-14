import { describe, expect, it } from "vitest";
import { makeHarness, seedUsers, ALICE, BOB, SAMPLE_PROBLEM } from "./setup";
import {
  createAttempt,
  submitAttempt,
  recordAttemptMerged,
} from "../src/lib/attempts/service";
import { buildFrontier } from "../src/lib/frontier/frontier";
import { problemVersionId } from "../src/lib/problems/catalog";
import { attempts } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";

const VERSION_ID = problemVersionId(
  SAMPLE_PROBLEM.problemKey,
  SAMPLE_PROBLEM.upstreamCommit,
  SAMPLE_PROBLEM.statementHash,
);

async function mergedAttempt(
  h: Awaited<ReturnType<typeof makeHarness>>,
  actor: typeof ALICE,
  title: string,
  kind: "lemma" | "exploration" | "refutation" | "proof",
) {
  const created = await createAttempt(h.ctx, actor, {
    problem: SAMPLE_PROBLEM,
    problemVersionId: VERSION_ID,
    kind,
    title,
    summary: `Summary for ${title} with enough characters.`,
  });
  await updateSummary(h, created.attempt_id, actor);
  const submitted = await submitAttempt(h.ctx, actor, {
    attemptId: created.attempt_id,
  });
  const mergeSha = h.github.mergePr(submitted.pr_number);
  await recordAttemptMerged(h.ctx, {
    attemptId: created.attempt_id,
    mergeCommitSha: mergeSha,
  });
  return created.attempt_id;
}

async function updateSummary(
  h: Awaited<ReturnType<typeof makeHarness>>,
  attemptId: string,
  actor: typeof ALICE,
) {
  const { updateAttempt } = await import("../src/lib/attempts/service");
  await updateAttempt(h.ctx, actor, {
    attemptId,
    manifestUpdates: { summary: "A sufficiently detailed summary." },
  });
}

describe("frontier generation", () => {
  it("ranks verified above unverified and excludes quarantined by default", async () => {
    const h = await makeHarness();
    await seedUsers(h);
    const unverified = await mergedAttempt(h, ALICE, "Speculative idea", "exploration");
    const verified = await mergedAttempt(h, BOB, "Verified lemma", "lemma");
    const quarantined = await mergedAttempt(h, BOB, "Spam", "exploration");

    await h.db
      .update(attempts)
      .set({ verificationStatus: "lean_verified" })
      .where(eq(attempts.attemptId, verified));
    await h.db
      .update(attempts)
      .set({ verificationStatus: "quarantined" })
      .where(eq(attempts.attemptId, quarantined));

    const { frontier } = await buildFrontier(h.db, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 20000,
    });
    const ids = frontier.map((f) => f.attempt_id);
    expect(ids).toContain(verified);
    expect(ids).toContain(unverified);
    expect(ids).not.toContain(quarantined);
    expect(ids.indexOf(verified)).toBeLessThan(ids.indexOf(unverified));
    const verifiedEntry = frontier.find((f) => f.attempt_id === verified);
    expect(verifiedEntry?.bucket).toBe("VERIFIED");
  });

  it("labels refuted work clearly", async () => {
    const h = await makeHarness();
    await seedUsers(h);
    const bad = await mergedAttempt(h, ALICE, "Wrong approach", "exploration");
    await h.db
      .update(attempts)
      .set({ verificationStatus: "refuted" })
      .where(eq(attempts.attemptId, bad));
    const { frontier } = await buildFrontier(h.db, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 20000,
    });
    const entry = frontier.find((f) => f.attempt_id === bad);
    expect(entry?.bucket).toBe("REFUTED");
  });

  it("respects the max_chars budget", async () => {
    const h = await makeHarness();
    await seedUsers(h);
    h.ctx.maxAttemptsPerDay = 50;
    h.ctx.maxSubmissionsPerDay = 50;
    h.ctx.maxOpenAttempts = 50;
    for (let i = 0; i < 8; i++) {
      await mergedAttempt(h, ALICE, `Attempt number ${i}`, "exploration");
    }
    const { frontier, truncated } = await buildFrontier(h.db, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 1500,
    });
    expect(frontier.length).toBeLessThan(8);
    expect(truncated).toBe(true);
  });

  it("parent edges are recorded and reconstructed", async () => {
    const h = await makeHarness();
    await seedUsers(h);
    const parent = await mergedAttempt(h, ALICE, "Base result", "lemma");
    const childCreated = await createAttempt(h.ctx, BOB, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "lemma",
      title: "Child result",
      summary: "Builds on the base result.",
      parents: [{ attempt_id: parent, relationship: "extends" }],
    });
    const edges = await h.db
      .select()
      .from((await import("../src/lib/db/schema")).attemptEdges)
      .where(
        eq(
          (await import("../src/lib/db/schema")).attemptEdges.childAttemptId,
          childCreated.attempt_id,
        ),
      );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.parentAttemptId).toBe(parent);
    expect(edges[0]?.relationship).toBe("extends");
  });

  it("rejects parents that are not merged", async () => {
    const h = await makeHarness();
    await seedUsers(h);
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
});
