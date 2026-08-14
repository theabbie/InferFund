import { getConfig } from "../config";
import { getGitHubService } from "../github/octokit-service";
import { validateAccessToken } from "./tokens";
import { isUserDisabled, tokensRevokedBefore } from "../attestations";
import type { Actor } from "../attempts/service";

export interface AuthenticatedRequest {
  actor: Actor;
  scopes: string[];
  clientId: string;
}

export async function authenticateBearer(
  req: Request,
): Promise<AuthenticatedRequest | null> {
  const header = req.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const config = getConfig();
  const validated = validateAccessToken(
    config.INFERFUND_TOKEN_SECRET,
    token,
    config.INFERFUND_MCP_RESOURCE_URL,
  );
  if (!validated) return null;
  try {
    const github = getGitHubService();
    const [disabled, revokedBefore] = await Promise.all([
      isUserDisabled(
        github,
        config.INFERFUND_PROGRESS_BRANCH,
        validated.githubUserId,
      ),
      tokensRevokedBefore(
        github,
        config.INFERFUND_PROGRESS_BRANCH,
        validated.githubUserId,
      ),
    ]);
    if (disabled) return null;
    if (
      revokedBefore !== null &&
      validated.issuedAt.getTime() < revokedBefore
    ) {
      return null;
    }
  } catch {
    void 0;
  }
  return {
    actor: {
      githubUserId: validated.githubUserId,
      githubLogin: validated.githubLogin,
    },
    scopes: validated.scopes,
    clientId: validated.clientId,
  };
}

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function oauthError(
  status: number,
  error: string,
  description: string,
): Response {
  return jsonResponse(status, { error, error_description: description });
}
