import { beforeEach, describe, expect, it } from "vitest";
import { makeHarness, ALICE, BOB, SAMPLE_PROBLEM } from "./setup";
import {
  createAttempt,
  findAttemptById,
  updateAttempt,
  submitAttempt,
} from "../src/lib/attempts/service";
import { parseManifest } from "../src/lib/attempts/manifest";
import { problemVersionId } from "../src/lib/problems/catalog";
import { resetRateLimitsForTests } from "../src/lib/ratelimit/limiter";

const VERSION_ID = problemVersionId(
  SAMPLE_PROBLEM.problemKey,
  SAMPLE_PROBLEM.upstreamCommit,
  SAMPLE_PROBLEM.statementHash,
);

beforeEach(() => {
  resetRateLimitsForTests();
});

describe("attempt lifecycle (Git-backed)", () => {
  it("creates an attempt: branch from exact progress head + scaffold", async () => {
    const h = makeHarness();
    const result = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "exploration",
      title: "Initial exploration",
    });
    expect(result.branch).toMatch(
      /^attempt\/u11111111\/erdos-1\/[0-9a-f-]{36}$/,
    );
    expect(result.base_progress_sha).toBe(h.progressSha);
    const files = h.github.filesOn(result.branch);
    expect(
      files[`attempts/erdos-1/${result.attempt_id}/manifest.json`],
    ).toBeDefined();
    expect(
      files[`attempts/erdos-1/${result.attempt_id}/README.md`],
    ).toContain("Initial exploration");
    const manifest = parseManifest(
      JSON.parse(files[`attempts/erdos-1/${result.attempt_id}/manifest.json`]!),
    );
    expect(manifest.author.github_user_id).toBe(ALICE.githubUserId);
    expect(manifest.base_progress_sha).toBe(h.progressSha);
    expect(manifest.kind).toBe("exploration");
  });

  it("owner can update; other user cannot", async () => {
    const h = makeHarness();
    const created = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "lemma",
      title: "Auxiliary bound",
    });
    const updated = await updateAttempt(h.ctx, ALICE, {
      attemptId: created.attempt_id,
      readmeBody: "# Auxiliary bound\n\nWe establish...",
    });
    expect(updated.files).toContain(
      `attempts/erdos-1/${created.attempt_id}/README.md`,
    );
    await expect(
      updateAttempt(h.ctx, BOB, {
        attemptId: created.attempt_id,
        readmeBody: "hijack",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_OWNED" });
  });

  it("rejects writes when writes are disabled (preview safety)", async () => {
    const h = makeHarness();
    h.ctx.writesEnabled = false;
    await expect(
      createAttempt(h.ctx, ALICE, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "exploration",
        title: "Nope",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("enforces the open-attempt quota", async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) {
      await createAttempt(h.ctx, ALICE, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "exploration",
        title: `Attempt ${i}`,
      });
    }
    await expect(
      createAttempt(h.ctx, ALICE, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "exploration",
        title: "One too many",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("enforces per-day creation rate limit, isolated per user", async () => {
    const h = makeHarness();
    h.ctx.maxOpenAttempts = 50;
    h.ctx.maxAttemptsPerDay = 2;
    await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "exploration",
      title: "A1",
    });
    await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "exploration",
      title: "A2",
    });
    await expect(
      createAttempt(h.ctx, ALICE, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "exploration",
        title: "A3",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(
      createAttempt(h.ctx, BOB, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "exploration",
        title: "B1",
      }),
    ).resolves.toBeTruthy();
  });

  it("idempotency key returns the same attempt without duplicating", async () => {
    const h = makeHarness();
    const first = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "exploration",
      title: "Idempotent",
      idempotencyKey: "key-12345678",
    });
    const second = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "exploration",
      title: "Idempotent",
      idempotencyKey: "key-12345678",
    });
    expect(second.attempt_id).toBe(first.attempt_id);
    expect(second.idempotent_replay).toBe(true);
    expect(
      (await h.github.listAttemptBranches("attempt/")).length,
    ).toBe(1);
  });

  it("submit creates a PR with base exactly progress and blocks further edits", async () => {
    const h = makeHarness();
    const created = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "proof",
      title: "A proof sketch",
      summary: "We show the bound by induction.",
    });
    const submitted = await submitAttempt(h.ctx, ALICE, {
      attemptId: created.attempt_id,
    });
    expect(submitted.pr_url).toContain("/pull/");
    const pr = await h.github.getPullRequest(submitted.pr_number);
    expect(pr?.baseBranch).toBe("progress");
    expect(pr?.headBranch).toBe(created.branch);
    await expect(
      updateAttempt(h.ctx, ALICE, {
        attemptId: created.attempt_id,
        readmeBody: "too late",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_ALREADY_SUBMITTED" });
  });

  it("submit rejects a manifest with a trivial summary", async () => {
    const h = makeHarness();
    const created = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "claim",
      title: "Empty claim",
    });
    await expect(
      submitAttempt(h.ctx, ALICE, { attemptId: created.attempt_id }),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  });

  it("rejects invalid artifact paths and oversize files", async () => {
    const h = makeHarness();
    const created = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "computation",
      title: "Compute things",
    });
    await expect(
      updateAttempt(h.ctx, ALICE, {
        attemptId: created.attempt_id,
        artifacts: [{ path: "../../escape.txt", content: "x" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_PATH" });
    await expect(
      updateAttempt(h.ctx, ALICE, {
        attemptId: created.attempt_id,
        artifacts: [{ path: "big.txt", content: "x".repeat(300 * 1024) }],
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  });

  it("rejects non-.lean files under lean/", async () => {
    const h = makeHarness();
    const created = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "formalization",
      title: "Formalize",
    });
    await expect(
      updateAttempt(h.ctx, ALICE, {
        attemptId: created.attempt_id,
        leanFiles: [{ name: "evil.sh", content: "rm -rf /" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_PATH" });
  });

  it("GitHub failure during creation leaves no branch behind on later retry", async () => {
    const h = makeHarness();
    h.github.failNextOperation = "createBranch";
    await expect(
      createAttempt(h.ctx, ALICE, {
        problem: SAMPLE_PROBLEM,
        problemVersionId: VERSION_ID,
        kind: "exploration",
        title: "Will fail",
      }),
    ).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(await h.github.listAttemptBranches("attempt/")).toHaveLength(0);
  });

  it("attempt status derives from git: pending → submitted → merged", async () => {
    const h = makeHarness();
    const created = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "lemma",
      title: "Status tracking",
      summary: "Meaningful summary here.",
    });
    let record = await findAttemptById(h.ctx, created.attempt_id);
    expect(record?.status).toBe("pending");
    const submitted = await submitAttempt(h.ctx, ALICE, {
      attemptId: created.attempt_id,
    });
    record = await findAttemptById(h.ctx, created.attempt_id);
    expect(record?.status).toBe("submitted");
    h.github.mergePr(submitted.pr_number);
    record = await findAttemptById(h.ctx, created.attempt_id);
    expect(record?.status).toBe("merged");
    expect(record?.branchName).toBe(created.branch);
  });

  it("merged attempts are immutable through update_attempt", async () => {
    const h = makeHarness();
    const created = await createAttempt(h.ctx, ALICE, {
      problem: SAMPLE_PROBLEM,
      problemVersionId: VERSION_ID,
      kind: "lemma",
      title: "Immutable once merged",
      summary: "Meaningful summary here.",
    });
    const submitted = await submitAttempt(h.ctx, ALICE, {
      attemptId: created.attempt_id,
    });
    h.github.mergePr(submitted.pr_number);
    await h.github.deleteBranch(created.branch);
    await expect(
      updateAttempt(h.ctx, ALICE, {
        attemptId: created.attempt_id,
        readmeBody: "rewrite history",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });
  });
});
