import { getConfig } from "../config";
import { githubAuthorizeUrl } from "./github-oauth";
import {
  resolveClient,
  validateRedirectUri,
  type RegisteredClient,
} from "./clients";
import { filterGrantableScopes, parseScopeString } from "./scopes";
import {
  issueSignedPayload,
  nowSeconds,
  verifySignedPayload,
  UPSTREAM_STATE_TTL_SECONDS,
  type SignedPayload,
} from "./stateless";

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
      description:
        "PKCE is required: code_challenge and code_challenge_method must be present.",
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
  const client = await resolveClient(params.clientId);
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
  const grantable = filterGrantableScopes(requestedScopes, new Set<number>(), -1);
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

export function oauthClientCredentials(): {
  clientId: string;
  clientSecret: string;
  scope?: string;
} {
  const config = getConfig();
  if (config.GITHUB_OAUTH_CLIENT_ID && config.GITHUB_OAUTH_CLIENT_SECRET) {
    return {
      clientId: config.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
      scope: "read:user",
    };
  }
  if (config.GITHUB_APP_CLIENT_ID && config.GITHUB_APP_CLIENT_SECRET) {
    return {
      clientId: config.GITHUB_APP_CLIENT_ID,
      clientSecret: config.GITHUB_APP_CLIENT_SECRET,
      scope: undefined,
    };
  }
  throw new Error(
    "GitHub user-login credentials are not configured. Set either " +
      "GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET (OAuth App) or " +
      "GITHUB_APP_CLIENT_ID/GITHUB_APP_CLIENT_SECRET (GitHub App user OAuth).",
  );
}

export function beginGitHubAuthorization(
  params: AuthorizeRequestParams,
  validated: Extract<AuthorizeValidation, { ok: true }>,
): { upstreamState: string; githubUrl: string } {
  const config = getConfig();
  const upstream = oauthClientCredentials();
  const now = nowSeconds();
  const upstreamState = issueSignedPayload(config.INFERFUND_SESSION_SECRET, {
    v: 1,
    typ: "state",
    cid: params.clientId,
    ruri: params.redirectUri,
    cstate: params.state ?? "",
    scp: validated.scopes,
    res: validated.resource,
    cc: validated.codeChallenge,
    ccm: validated.codeChallengeMethod,
    iat: now,
    exp: now + UPSTREAM_STATE_TTL_SECONDS,
  });
  const callbackUrl = `${config.INFERFUND_BASE_URL}/auth/github/callback`;
  const githubUrl = githubAuthorizeUrl({
    clientId: upstream.clientId,
    redirectUri: callbackUrl,
    state: upstreamState,
    scope: upstream.scope,
  });
  return { upstreamState, githubUrl };
}

export function consumeUpstreamState(state: string): SignedPayload | null {
  const config = getConfig();
  return verifySignedPayload(config.INFERFUND_SESSION_SECRET, state, "state");
}
