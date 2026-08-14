import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getConfig } from "@/lib/config";
import { authenticateBearer, jsonResponse } from "@/lib/auth/authenticate";
import { SCOPES } from "@/lib/auth/scopes";
import { users } from "@/lib/db/schema";
import {
  quarantineAttempt,
  unquarantineAttempt,
} from "@/lib/moderation/service";
import { revokeAllUserTokens } from "@/lib/auth/tokens";
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
    db: getDb(),
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
  const auth = await authenticateBearer(req);
  const config = getConfig();
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
  const parsed = adminActionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonResponse(400, {
      code: "INVALID_INPUT",
      message: "Unknown or malformed admin action.",
    });
  }
  const action = parsed.data;
  const ctx = serviceContext();
  const db = getDb();

  switch (action.action) {
    case "quarantine":
      await quarantineAttempt(ctx, auth.actor, {
        attemptId: action.attempt_id,
        reason: action.reason,
      });
      return jsonResponse(200, { ok: true, action: "quarantine" });
    case "unquarantine":
      await unquarantineAttempt(ctx, auth.actor, {
        attemptId: action.attempt_id,
        reason: action.reason,
      });
      return jsonResponse(200, { ok: true, action: "unquarantine" });
    case "disable_user": {
      await db
        .update(users)
        .set({ disabled: true })
        .where(eq(users.githubUserId, action.github_user_id));
      await revokeAllUserTokens(db, action.github_user_id);
      await audit(db, {
        actorGithubUserId: auth.actor.githubUserId,
        actorKind: "admin",
        action: "user_disabled",
        targetType: "user",
        targetId: String(action.github_user_id),
        details: { reason: action.reason },
      });
      return jsonResponse(200, { ok: true, action: "disable_user" });
    }
    case "enable_user": {
      await db
        .update(users)
        .set({ disabled: false })
        .where(eq(users.githubUserId, action.github_user_id));
      await audit(db, {
        actorGithubUserId: auth.actor.githubUserId,
        actorKind: "admin",
        action: "user_enabled",
        targetType: "user",
        targetId: String(action.github_user_id),
      });
      return jsonResponse(200, { ok: true, action: "enable_user" });
    }
    case "revoke_tokens": {
      await revokeAllUserTokens(db, action.github_user_id);
      await audit(db, {
        actorGithubUserId: auth.actor.githubUserId,
        actorKind: "admin",
        action: "tokens_revoked",
        targetType: "user",
        targetId: String(action.github_user_id),
      });
      return jsonResponse(200, { ok: true, action: "revoke_tokens" });
    }
  }
}
