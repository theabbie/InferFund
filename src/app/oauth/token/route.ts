import { getConfig } from "@/lib/config";
import {
  issueTokens,
  redeemAuthorizationCode,
  rotateRefreshToken,
} from "@/lib/auth/tokens";
import { jsonResponse, oauthError } from "@/lib/auth/authenticate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function tokenResponse(input: {
  accessToken: string;
  expiresAt: Date;
  refreshToken?: string;
  scopes: string[];
}): Response {
  return jsonResponse(
    200,
    {
      access_token: input.accessToken,
      token_type: "Bearer",
      expires_in: Math.max(
        0,
        Math.floor((input.expiresAt.getTime() - Date.now()) / 1000),
      ),
      refresh_token: input.refreshToken,
      scope: input.scopes.join(" "),
    },
    CORS,
  );
}

export async function POST(req: Request): Promise<Response> {
  const config = getConfig();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await req.text());
  } catch {
    return oauthError(400, "invalid_request", "Malformed form body.");
  }
  const grantType = params.get("grant_type");
  const clientId = params.get("client_id") ?? "";
  const resource =
    params.get("resource") ?? config.INFERFUND_MCP_RESOURCE_URL;

  if (resource !== config.INFERFUND_MCP_RESOURCE_URL) {
    return oauthError(
      400,
      "invalid_target",
      "resource must be the InferFund MCP resource URL.",
    );
  }
  if (!clientId) {
    return oauthError(400, "invalid_request", "client_id is required.");
  }

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const codeVerifier = params.get("code_verifier") ?? "";
    if (!code || !redirectUri || !codeVerifier) {
      return oauthError(
        400,
        "invalid_request",
        "code, redirect_uri and code_verifier are required.",
      );
    }
    const redeemed = redeemAuthorizationCode(config.INFERFUND_TOKEN_SECRET, {
      code,
      clientId,
      redirectUri,
      codeVerifier,
      resource,
    });
    if (!redeemed.ok) {
      return oauthError(
        400,
        redeemed.error,
        "The authorization code is invalid, expired, or failed PKCE " +
          "verification.",
      );
    }
    const tokens = issueTokens(config.INFERFUND_TOKEN_SECRET, {
      clientId,
      githubUserId: redeemed.githubUserId,
      githubLogin: redeemed.githubLogin,
      scopes: redeemed.scopes,
      resource,
    });
    return tokenResponse({
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessTokenExpiresAt,
      refreshToken: tokens.refreshToken,
      scopes: redeemed.scopes,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token") ?? "";
    if (!refreshToken) {
      return oauthError(400, "invalid_request", "refresh_token is required.");
    }
    const rotated = rotateRefreshToken(config.INFERFUND_TOKEN_SECRET, {
      refreshToken,
      clientId,
      resource,
    });
    if (!rotated.ok) {
      return oauthError(
        400,
        rotated.error,
        "The refresh token is invalid or expired.",
      );
    }
    return tokenResponse({
      accessToken: rotated.tokens.accessToken,
      expiresAt: rotated.tokens.accessTokenExpiresAt,
      refreshToken: rotated.tokens.refreshToken,
      scopes: rotated.tokens.scopes,
    });
  }

  return oauthError(
    400,
    "unsupported_grant_type",
    "Supported grants: authorization_code, refresh_token.",
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
