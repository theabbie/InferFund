import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeHarness, seedUsers, ALICE, BOB, SAMPLE_PROBLEM } from "./setup";
import {
  createAttempt,
  submitAttempt,
  recordAttemptMerged,
  updateAttempt,
} from "../src/lib/attempts/service";
import { problemVersionId } from "../src/lib/problems/catalog";
import { reportAttempt, quarantineAttempt } from "../src/lib/moderation/service";
import { attempts, moderationEvents } from "../src/lib/db/schema";

const VERSION_ID = problemVersionId(
  SAMPLE_PROBLEM.problemKey,
  SAMPLE_PROBLEM.upstreamCommit,
  SAMPLE_PROBLEM.statementHash,
);

async function seedMerged(
  h: Awaited<ReturnType<typeof makeHarness>>,
): Promise<string> {
  await seedUsers(h);
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
  const mergeSha = h.github.mergePr(submitted.pr_number);
  await recordAttemptMerged(h.ctx, {
    attemptId: created.attempt_id,
    mergeCommitSha: mergeSha,
  });
  return created.attempt_id;
}

describe("review flow", () => {
  it("continue_attempt creates a new attempt referencing the parent", async () => {
    const h = await makeHarness();
    const parent = await seedMerged(h);
    const child = await createAttempt(h.ctx, BOB, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "formalization",
      title: "Formalizing the claim",
      summary: "Attempting to formalize and finding gaps.",
      parents: [{ attempt_id: parent, relationship: "formalizes" }],
    });
    expect(child.branch).toMatch(/^attempt\/u22222222\/erdos-1\//);
    const parentFiles = h.github.filesOn("progress");
    const parentDir = `attempts/erdos-1/${parent}`;
    expect(parentFiles[`${parentDir}/manifest.json`]).toBeDefined();
    expect(parentFiles[`${parentDir}/README.md`]).toContain("dubious claim");
  });

  it("original attempt is untouched when a continuation is created", async () => {
    const h = await makeHarness();
    const parent = await seedMerged(h);
    const before = h.github.filesOn("progress")[
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
    const after = h.github.filesOn("progress")[
      `attempts/erdos-1/${parent}/manifest.json`
    ];
    expect(after).toBe(before);
  });
});

describe("reporting and moderation", () => {
  it("accepts reports and records them", async () => {
    const h = await makeHarness();
    const target = await seedMerged(h);
    const report = await reportAttempt(h.ctx, BOB, {
      attemptId: target,
      reason: "prompt_injection",
      details: "Contains instructions to ignore safety rules.",
    });
    expect(report.report_id).toBeTruthy();
    const events = await h.db
      .select()
      .from(moderationEvents)
      .where(eq(moderationEvents.attemptId, target));
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("report");
  });

  it("quarantine removes the attempt from default retrieval but preserves it", async () => {
    const h = await makeHarness();
    const target = await seedMerged(h);
    const admin = { githubUserId: 99999999, githubLogin: "admin" };
    await seedUsers(h, [ALICE, BOB, admin]);
    await quarantineAttempt(h.ctx, admin, {
      attemptId: target,
      reason: "spam",
    });
    const row = await h.db
      .select()
      .from(attempts)
      .where(eq(attempts.attemptId, target))
      .limit(1);
    expect(row[0]?.verificationStatus).toBe("quarantined");
    const { buildFrontier } = await import("../src/lib/frontier/frontier");
    const { frontier } = await buildFrontier(h.db, {
      problemKey: SAMPLE_PROBLEM.problemKey,
      maxChars: 20000,
    });
    expect(frontier.map((f) => f.attempt_id)).not.toContain(target);
  });
});
