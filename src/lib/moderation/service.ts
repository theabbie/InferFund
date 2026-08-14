import { InferFundError } from "../errors";
import { consumeRateLimit, RATE_LIMITS } from "../ratelimit/limiter";
import { audit } from "../audit/log";
import { createAttestationPr } from "../attestations";
import type { Actor, ServiceContext } from "../attempts/service";
import { findAttemptById } from "../attempts/service";

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
  consumeRateLimit(`u${actor.githubUserId}`, RATE_LIMITS.reportPerDay);
  const target = await findAttemptById(ctx, input.attemptId);
  if (!target) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist.`,
    );
  }
  const reportId = crypto.randomUUID();
  let issueUrl: string | null = null;
  try {
    issueUrl = await ctx.github.createIssue(
      `[moderation] ${input.reason}: attempt ${input.attemptId.slice(0, 8)}`,
      [
        `Reported attempt: \`${input.attemptId}\``,
        `Problem: \`${target.problemKey}\``,
        `Reason: \`${input.reason}\``,
        `Reporter: ${actor.githubLogin} (${actor.githubUserId})`,
        "",
        input.details?.slice(0, 2000) ?? "",
      ].join("\n"),
      ["moderation-report"],
    );
  } catch {
    issueUrl = null;
  }
  audit({
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_reported",
    targetType: "attempt",
    targetId: input.attemptId,
    details: { reason: input.reason, issue: issueUrl },
  });
  return { report_id: reportId };
}

export async function quarantineAttempt(
  ctx: ServiceContext,
  admin: Actor,
  input: { attemptId: string; reason: string },
): Promise<{ attestation_id: string }> {
  const target = await findAttemptById(ctx, input.attemptId);
  if (!target) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist.`,
    );
  }
  const result = await createAttestationPr(ctx.github, ctx.progressBranch, {
    type: "quarantined",
    attempt_id: input.attemptId,
    actor_kind: "admin",
    actor_github_user_id: admin.githubUserId,
    reason: input.reason.slice(0, 2000),
  });
  audit({
    actorGithubUserId: admin.githubUserId,
    actorKind: "admin",
    action: "attempt_quarantined",
    targetType: "attempt",
    targetId: input.attemptId,
    details: { reason: input.reason.slice(0, 500) },
  });
  return { attestation_id: result.attestation_id };
}

export async function unquarantineAttempt(
  ctx: ServiceContext,
  admin: Actor,
  input: { attemptId: string; reason: string },
): Promise<{ attestation_id: string }> {
  const target = await findAttemptById(ctx, input.attemptId);
  if (!target) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist.`,
    );
  }
  const result = await createAttestationPr(ctx.github, ctx.progressBranch, {
    type: "unquarantined",
    attempt_id: input.attemptId,
    actor_kind: "admin",
    actor_github_user_id: admin.githubUserId,
    reason: input.reason.slice(0, 2000),
  });
  audit({
    actorGithubUserId: admin.githubUserId,
    actorKind: "admin",
    action: "attempt_unquarantined",
    targetType: "attempt",
    targetId: input.attemptId,
  });
  return { attestation_id: result.attestation_id };
}
