import { describe, expect, it } from "vitest";
import {
  attemptBranchName,
  attemptDirectory,
  contentHash,
  isUuidV7,
  newAttemptId,
  parseAttemptBranchName,
  sanitizeProblemKey,
} from "../src/lib/ids";

describe("branch naming", () => {
  it("generates canonical branch names", () => {
    const id = newAttemptId();
    const branch = attemptBranchName({
      prefix: "attempt",
      githubUserId: 17960677,
      problemKey: "erdos-123",
      attemptId: id,
    });
    expect(branch).toBe(`attempt/u17960677/erdos-123/${id}`);
  });

  it("includes the numeric GitHub user ID", () => {
    const branch = attemptBranchName({
      prefix: "attempt",
      githubUserId: 42,
      problemKey: "erdos-1",
      attemptId: newAttemptId(),
    });
    expect(branch.startsWith("attempt/u42/")).toBe(true);
  });

  it("generates valid UUIDv7 attempt IDs", () => {
    const id = newAttemptId();
    expect(isUuidV7(id)).toBe(true);
  });

  it("never generates the same branch twice", () => {
    const a = attemptBranchName({
      prefix: "attempt",
      githubUserId: 1,
      problemKey: "p",
      attemptId: newAttemptId(),
    });
    const b = attemptBranchName({
      prefix: "attempt",
      githubUserId: 1,
      problemKey: "p",
      attemptId: newAttemptId(),
    });
    expect(a).not.toBe(b);
  });

  it("parses branch names back", () => {
    const id = newAttemptId();
    const branch = attemptBranchName({
      prefix: "attempt",
      githubUserId: 999,
      problemKey: "hilbert-10",
      attemptId: id,
    });
    const parsed = parseAttemptBranchName(branch);
    expect(parsed).toEqual({
      githubUserId: 999,
      problemKey: "hilbert-10",
      attemptId: id,
    });
  });

  it("rejects invalid branch names on parse", () => {
    expect(parseAttemptBranchName("main")).toBeNull();
    expect(
      parseAttemptBranchName("attempt/ualice/erdos-1/not-a-uuid"),
    ).toBeNull();
    expect(
      parseAttemptBranchName(
        "attempt/u1/erdos-1/0195e7c0-8e7a-1f82-bfa2-a91338dd7b53",
      ),
    ).toBeNull();
  });

  it("sanitizes problem keys", () => {
    expect(sanitizeProblemKey("Erdős Problem #1!")).toBe("erd-s-problem-1");
    expect(sanitizeProblemKey("erdos-123")).toBe("erdos-123");
    expect(sanitizeProblemKey("--A__B--")).toBe("a-b");
  });

  it("computes content hashes", () => {
    expect(contentHash("hello")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("builds attempt directories", () => {
    const id = newAttemptId();
    expect(attemptDirectory("erdos-1", id)).toBe(`attempts/erdos-1/${id}`);
  });
});
