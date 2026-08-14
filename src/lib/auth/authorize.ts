import { eq } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import { oauthUpstreamStates } from "../db/schema";
import { getConfig } from "../config";
import { randomToken, sha256Hex } from "../ids";
import { githubAuthorizeUrl } from "./github-oauth";
import {
  resolveClient,
  validateRedirectUri,
  type RegisteredClient,
} from "./clients";
import { filterGrantableScopes, parseScopeString } from "./scopes";
import { UPSTREAM_STATE_TTL_SECONDS } from "./tokens";

export interface AuthorizeRequestParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  state?: string;
  scope?: string;
  resource?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export type AuthorizeValidation =
  | {
      ok: true;
      client: RegisteredClient;
      scopes: string[];
      resource: string;
      codeChallenge: string;
      codeChallengeMethod: string;
    }
  | { ok: false; status: number; error: string; description: string };

export async function validateAuthorizeRequest(
  db: AnyDatabase,
  params: AuthorizeRequestParams,
): Promise<AuthorizeValidation> {
  const config = getConfig();
  if (params.responseType !== "code") {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "response_type must be \"code\".",
    };
  }
  if (!params.codeChallenge || !params.codeChallengeMethod) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "PKCE is required: code_challenge and " +
        "code_challenge_method must be present.",
    };
  }
  if (params.codeChallengeMethod !== "S256") {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "code_challenge_method must be S256.",
    };
  }
  const resource = params.resource ?? config.INFERFUND_MCP_RESOURCE_URL;
  if (resource !== config.INFERFUND_MCP_RESOURCE_URL) {
    return {
      ok: false,
      status: 400,
      error: "invalid_target",
      description:
        "resource must be the InferFund MCP resource URL: " +
        config.INFERFUND_MCP_RESOURCE_URL,
    };
  }
  const client = await resolveClient(db, params.clientId);
  if (!client) {
    return {
      ok: false,
      status: 400,
      error: "invalid_client",
      description:
        "Unknown client_id. Register via /oauth/register or use a Client ID " +
        "Metadata Document URL.",
    };
  }
  if (!validateRedirectUri(client, params.redirectUri)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "redirect_uri is not registered for this client.",
    };
  }
  const requestedScopes = parseScopeString(params.scope);
  const grantable = filterGrantableScopes(
    requestedScopes,
    new Set<number>(),
    -1,
  );
  if (grantable === null) {
    return {
      ok: false,
      status: 400,
      error: "invalid_scope",
      description:
        "Unknown scope. Supported: inferfund:read, inferfund:contribute.",
    };
  }
  const scopes = grantable.filter((s) => s !== "inferfund:admin");
  return {
    ok: true,
    client,
    scopes,
    resource,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
  };
}

export async function beginGitHubAuthorization(
  db: AnyDatabase,
  params: AuthorizeRequestParams,
  validated: Extract<AuthorizeValidation, { ok: true }>,
): Promise<{ upstreamState: string; githubUrl: string }> {
  const config = getConfig();
  if (!config.GITHUB_OAUTH_CLIENT_ID || !config.GITHUB_OAUTH_CLIENT_SECRET) {
    throw new Error(
      "GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET are not configured.",
    );
  }
  const upstreamState = `ifs_${randomToken(24)}`;
  await db.insert(oauthUpstreamStates).values({
    stateHash: sha256Hex(upstreamState),
    clientId: params.clientId,
    clientRedirectUri: params.redirectUri,
    clientState: params.state ?? "",
    scopes: validated.scopes,
    resource: validated.resource,
    codeChallenge: validated.codeChallenge,
    codeChallengeMethod: validated.codeChallengeMethod,
    expiresAt: new Date(Date.now() + UPSTREAM_STATE_TTL_SECONDS * 1000),
  });
  const callbackUrl = `${config.INFERFUND_BASE_URL}/auth/github/callback`;
  const githubUrl = githubAuthorizeUrl({
    clientId: config.GITHUB_OAUTH_CLIENT_ID,
    redirectUri: callbackUrl,
    state: upstreamState,
  });
  return { upstreamState, githubUrl };
}

export async function consumeUpstreamState(
  db: AnyDatabase,
  state: string,
): Promise<typeof oauthUpstreamStates.$inferSelect | null> {
  const stateHash = sha256Hex(state);
  const rows = await db
    .select()
    .from(oauthUpstreamStates)
    .where(eq(oauthUpstreamStates.stateHash, stateHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  await db
    .update(oauthUpstreamStates)
    .set({ usedAt: new Date() })
    .where(eq(oauthUpstreamStates.stateHash, stateHash));
  return row;
}
