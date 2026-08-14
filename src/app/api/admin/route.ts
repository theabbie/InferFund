import { z } from "zod";
import { getConfig } from "@/lib/config";
import { authenticateBearer, jsonResponse } from "@/lib/auth/authenticate";
import { SCOPES } from "@/lib/auth/scopes";
import {
  quarantineAttempt,
  unquarantineAttempt,
} from "@/lib/moderation/service";
import { createAttestationPr } from "@/lib/attestations";
import { audit } from "@/lib/audit/log";
import { getGitHubService } from "@/lib/github/octokit-service";
import type { ServiceContext } from "@/lib/attempts/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const adminActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("quarantine"),
    attempt_id: z.string(),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    action: z.literal("unquarantine"),
    attempt_id: z.string(),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    action: z.literal("disable_user"),
    github_user_id: z.number().int().positive(),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    action: z.literal("enable_user"),
    github_user_id: z.number().int().positive(),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    action: z.literal("revoke_tokens"),
    github_user_id: z.number().int().positive(),
    reason: z.string().min(1).max(2000),
  }),
]);

function serviceContext(): ServiceContext {
  const config = getConfig();
  return {
    github: getGitHubService(),
    progressBranch: config.INFERFUND_PROGRESS_BRANCH,
    attemptBranchPrefix: config.INFERFUND_ATTEMPT_BRANCH_PREFIX,
    maxOpenAttempts: config.INFERFUND_MAX_OPEN_ATTEMPTS,
    maxAttemptsPerDay: config.INFERFUND_MAX_ATTEMPTS_PER_DAY,
    maxSubmissionsPerDay: config.INFERFUND_MAX_SUBMISSIONS_PER_DAY,
    maxLeanSubmissionsPerDay: config.INFERFUND_MAX_LEAN_SUBMISSIONS_PER_DAY,
    maxAttemptBytes: config.INFERFUND_MAX_ATTEMPT_BYTES,
    maxFilesPerAttempt: config.INFERFUND_MAX_FILES_PER_ATTEMPT,
    writesEnabled: config.writesEnabled,
  };
}

export async function POST(req: Request): Promise<Response> {
  const config = getConfig();
  const auth = await authenticateBearer(req);
  if (
    !auth ||
    (!auth.scopes.includes(SCOPES.ADMIN) &&
      !config.adminGithubIds.has(auth.actor.githubUserId))
  ) {
    return jsonResponse(403, {
      code: "FORBIDDEN",
      message: "Admin scope required.",
    });
  }
  const parsed = adminActionSchema.safeParse(
    await req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return jsonResponse(400, {
      code: "INVALID_INPUT",
      message: "Unknown or malformed admin action.",
    });
  }
  const action = parsed.data;
  const ctx = serviceContext();

  switch (action.action) {
    case "quarantine": {
      const result = await quarantineAttempt(ctx, auth.actor, {
        attemptId: action.attempt_id,
        reason: action.reason,
      });
      return jsonResponse(200, { ok: true, ...result });
    }
    case "unquarantine": {
      const result = await unquarantineAttempt(ctx, auth.actor, {
        attemptId: action.attempt_id,
        reason: action.reason,
      });
      return jsonResponse(200, { ok: true, ...result });
    }
    case "disable_user": {
      const result = await createAttestationPr(
        ctx.github,
        ctx.progressBranch,
        {
          type: "user_disabled",
          subject_github_user_id: action.github_user_id,
          actor_kind: "admin",
          actor_github_user_id: auth.actor.githubUserId,
          reason: action.reason,
          revoked_before: new Date().toISOString(),
        },
      );
      await createAttestationPr(ctx.github, ctx.progressBranch, {
        type: "tokens_revoked_before",
        subject_github_user_id: action.github_user_id,
        actor_kind: "admin",
        actor_github_user_id: auth.actor.githubUserId,
        revoked_before: new Date().toISOString(),
        reason: action.reason,
      });
      audit({
        actorGithubUserId: auth.actor.githubUserId,
        actorKind: "admin",
        action: "user_disabled",
        targetType: "user",
        targetId: String(action.github_user_id),
      });
      return jsonResponse(200, { ok: true, ...result });
    }
    case "enable_user": {
      const result = await createAttestationPr(
        ctx.github,
        ctx.progressBranch,
        {
          type: "user_enabled",
          subject_github_user_id: action.github_user_id,
          actor_kind: "admin",
          actor_github_user_id: auth.actor.githubUserId,
          reason: action.reason,
        },
      );
      audit({
        actorGithubUserId: auth.actor.githubUserId,
        actorKind: "admin",
        action: "user_enabled",
        targetType: "user",
        targetId: String(action.github_user_id),
      });
      return jsonResponse(200, { ok: true, ...result });
    }
    case "revoke_tokens": {
      const result = await createAttestationPr(
        ctx.github,
        ctx.progressBranch,
        {
          type: "tokens_revoked_before",
          subject_github_user_id: action.github_user_id,
          actor_kind: "admin",
          actor_github_user_id: auth.actor.githubUserId,
          revoked_before: new Date().toISOString(),
          reason: action.reason,
        },
      );
      audit({
        actorGithubUserId: auth.actor.githubUserId,
        actorKind: "admin",
        action: "tokens_revoked",
        targetType: "user",
        targetId: String(action.github_user_id),
      });
      return jsonResponse(200, { ok: true, ...result });
    }
  }
}
