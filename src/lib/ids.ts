import { createHash, randomBytes, createHmac } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { InferFundError } from "./errors";

export function newAttemptId(): string {
  return uuidv7();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function contentHash(data: string | Buffer): string {
  return `sha256:${sha256Hex(data)}`;
}

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

const PROBLEM_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function sanitizeProblemKey(raw: string): string {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return sanitized;
}

export function assertValidProblemKey(key: string): void {
  if (!PROBLEM_KEY_PATTERN.test(key) || key.length > 128) {
    throw new InferFundError(
      "INVALID_INPUT",
      `Invalid problem key: "${key}". Problem keys must match [a-z0-9-].`,
    );
  }
}

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

export function attemptBranchName(input: {
  prefix: string;
  githubUserId: number;
  problemKey: string;
  attemptId: string;
}): string {
  const { prefix, githubUserId, problemKey, attemptId } = input;
  if (!Number.isInteger(githubUserId) || githubUserId <= 0) {
    throw new InferFundError(
      "INVALID_INPUT",
      "githubUserId must be a positive integer.",
    );
  }
  assertValidProblemKey(problemKey);
  if (!isUuidV7(attemptId)) {
    throw new InferFundError(
      "INVALID_INPUT",
      `attemptId must be a UUIDv7, got "${attemptId}".`,
    );
  }
  const safePrefix = sanitizeProblemKey(prefix) || "attempt";
  return `${safePrefix}/u${githubUserId}/${problemKey}/${attemptId}`;
}

const ATTEMPT_BRANCH_PATTERN =
  /^attempt\/u(?<userId>[0-9]+)\/(?<problemKey>[a-z0-9][a-z0-9-]*)\/(?<attemptId>[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function parseAttemptBranchName(branch: string): {
  githubUserId: number;
  problemKey: string;
  attemptId: string;
} | null {
  const match = ATTEMPT_BRANCH_PATTERN.exec(branch);
  if (!match?.groups) return null;
  return {
    githubUserId: Number(match.groups.userId),
    problemKey: match.groups.problemKey,
    attemptId: match.groups.attemptId,
  };
}

export function attemptDirectory(
  problemKey: string,
  attemptId: string,
): string {
  assertValidProblemKey(problemKey);
  if (!isUuidV7(attemptId)) {
    throw new InferFundError(
      "INVALID_INPUT",
      `attemptId must be a UUIDv7, got "${attemptId}".`,
    );
  }
  return `attempts/${problemKey}/${attemptId}`;
}
