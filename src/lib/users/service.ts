import type { GitHubService } from "../github/service";
import { audit } from "../audit/log";

export async function ensureCollaboration(
  github: GitHubService,
  user: { githubUserId: number; githubLogin: string },
): Promise<{ status: string; permission?: string }> {
  let status: { status: string; permission?: string };
  try {
    status = await github.ensureCollaborator(user.githubLogin);
  } catch {
    status = { status: "failed" };
  }
  audit({
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
  return status;
}
