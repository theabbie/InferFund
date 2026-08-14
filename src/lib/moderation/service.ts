import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { attempts, moderationEvents } from "../db/schema";
import { InferFundError } from "../errors";
import { consumeRateLimit, RATE_LIMITS } from "../ratelimit/limiter";
import { audit } from "../audit/log";
import type { Actor, ServiceContext } from "../attempts/service";

export const REPORT_REASONS = [
  "spam",
  "prompt_injection",
  "abusive_content",
  "plagiarism",
  "unrelated_content",
  "credential_leakage",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export async function reportAttempt(
  ctx: ServiceContext,
  actor: Actor,
  input: { attemptId: string; reason: ReportReason; details?: string },
): Promise<{ report_id: string }> {
  await consumeRateLimit(ctx.db, {
    subject: `u${actor.githubUserId}`,
    rule: RATE_LIMITS.reportPerDay,
  });
  const target = await ctx.db
    .select()
    .from(attempts)
    .where(eq(attempts.attemptId, input.attemptId))
    .limit(1);
  if (!target[0]) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist.`,
    );
  }
  const id = randomUUID();
  await ctx.db.insert(moderationEvents).values({
    id,
    attemptId: input.attemptId,
    reporterGithubUserId: actor.githubUserId,
    action: "report",
    reason: input.reason,
    details: { text: input.details?.slice(0, 2000) },
  });
  await audit(ctx.db, {
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_reported",
    targetType: "attempt",
    targetId: input.attemptId,
    details: { reason: input.reason },
  });
  return { report_id: id };
}

export async function quarantineAttempt(
  ctx: ServiceContext,
  admin: Actor,
  input: { attemptId: string; reason: string },
): Promise<void> {
  const updated = await ctx.db
    .update(attempts)
    .set({ verificationStatus: "quarantined", updatedAt: new Date() })
    .where(eq(attempts.attemptId, input.attemptId))
    .returning({ attemptId: attempts.attemptId });
  if (!updated[0]) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist.`,
    );
  }
  await ctx.db.insert(moderationEvents).values({
    id: randomUUID(),
    attemptId: input.attemptId,
    adminGithubUserId: admin.githubUserId,
    action: "quarantine",
    reason: input.reason.slice(0, 2000),
  });
  await audit(ctx.db, {
    actorGithubUserId: admin.githubUserId,
    actorKind: "admin",
    action: "attempt_quarantined",
    targetType: "attempt",
    targetId: input.attemptId,
    details: { reason: input.reason.slice(0, 500) },
  });
}

export async function unquarantineAttempt(
  ctx: ServiceContext,
  admin: Actor,
  input: { attemptId: string; reason: string },
): Promise<void> {
  const updated = await ctx.db
    .update(attempts)
    .set({ verificationStatus: "unverified", updatedAt: new Date() })
    .where(eq(attempts.attemptId, input.attemptId))
    .returning({ attemptId: attempts.attemptId });
  if (!updated[0]) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist.`,
    );
  }
  await ctx.db.insert(moderationEvents).values({
    id: randomUUID(),
    attemptId: input.attemptId,
    adminGithubUserId: admin.githubUserId,
    action: "unquarantine",
    reason: input.reason.slice(0, 2000),
  });
  await audit(ctx.db, {
    actorGithubUserId: admin.githubUserId,
    actorKind: "admin",
    action: "attempt_unquarantined",
    targetType: "attempt",
    targetId: input.attemptId,
  });
}
