import { getConfig } from "../config";
import { getDb } from "../db/client";
import { getGitHubService } from "../github/octokit-service";
import { validateAccessToken } from "./tokens";
import { getActorFromToken, type Actor } from "../attempts/service";
import { InferFundError } from "../errors";

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
  const db = getDb();
  const validated = await validateAccessToken(
    db,
    config.INFERFUND_TOKEN_SECRET,
    token,
  );
  if (!validated) return null;
  if (validated.resource !== config.INFERFUND_MCP_RESOURCE_URL) return null;
  const serviceCtx = {
    db,
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
  try {
    const actor = await getActorFromToken(serviceCtx, validated.githubUserId);
    return {
      actor,
      scopes: validated.scopes,
      clientId: validated.clientId,
    };
  } catch (error) {
    if (error instanceof InferFundError) return null;
    throw error;
  }
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
