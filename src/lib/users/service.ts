import { eq } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import { githubCollaborations, users } from "../db/schema";
import type { GitHubIdentity } from "../auth/github-oauth";
import type { GitHubService } from "../github/service";
import { audit } from "../audit/log";

export async function upsertUserFromGitHub(
  db: AnyDatabase,
  identity: GitHubIdentity,
): Promise<typeof users.$inferSelect> {
  const now = new Date();
  const rows = await db
    .insert(users)
    .values({
      githubUserId: identity.id,
      githubLogin: identity.login,
      githubAvatarUrl: identity.avatar_url ?? null,
      createdAt: now,
      lastAuthenticatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.githubUserId,
      set: {
        githubLogin: identity.login,
        githubAvatarUrl: identity.avatar_url ?? null,
        lastAuthenticatedAt: now,
      },
    })
    .returning();
  return rows[0]!;
}

export async function getUserByGithubId(
  db: AnyDatabase,
  githubUserId: number,
): Promise<typeof users.$inferSelect | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.githubUserId, githubUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function ensureCollaboration(
  db: AnyDatabase,
  github: GitHubService,
  user: { githubUserId: number; githubLogin: string },
): Promise<{ status: string; permission?: string }> {
  const existing = await db
    .select()
    .from(githubCollaborations)
    .where(eq(githubCollaborations.githubUserId, user.githubUserId))
    .limit(1);
  if (
    existing[0] &&
    (existing[0].status === "active" || existing[0].status === "invited") &&
    Date.now() - existing[0].lastCheckedAt.getTime() < 24 * 3600 * 1000
  ) {
    return {
      status: existing[0].status,
      permission: existing[0].permission ?? undefined,
    };
  }
  let status: { status: string; permission?: string; invitationId?: number };
  try {
    status = await github.ensureCollaborator(user.githubLogin);
  } catch {
    status = { status: "failed" };
  }
  await db
    .insert(githubCollaborations)
    .values({
      githubUserId: user.githubUserId,
      status: status.status as "none" | "invited" | "active" | "failed",
      permission: status.permission ?? null,
      invitationId: status.invitationId ?? null,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: githubCollaborations.githubUserId,
      set: {
        status: status.status as "none" | "invited" | "active" | "failed",
        permission: status.permission ?? null,
        invitationId: status.invitationId ?? null,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  await audit(db, {
    actorGithubUserId: user.githubUserId,
    actorKind: "system",
    action:
      status.status === "invited" || status.status === "active"
        ? "collaborator_added"
        : "collaborator_invite_failed",
    targetType: "user",
    targetId: String(user.githubUserId),
    details: { status: status.status, permission: status.permission },
  });
  return { status: status.status, permission: status.permission };
}
