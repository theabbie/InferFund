import { createHash, timingSafeEqual } from "node:crypto";
import {
  issueSignedPayload,
  nowSeconds,
  verifySignedPayload,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  UPSTREAM_STATE_TTL_SECONDS,
} from "./stateless";

export {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  UPSTREAM_STATE_TTL_SECONDS,
};

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  if (method !== "S256") return false;
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  scopes: string[];
}

export function issueTokens(
  tokenSecret: string,
  input: {
    clientId: string;
    githubUserId: number;
    githubLogin: string;
    scopes: string[];
    resource: string;
  },
): IssuedTokens {
  const now = nowSeconds();
  const accessExp = now + ACCESS_TOKEN_TTL_SECONDS;
  const refreshExp = now + REFRESH_TOKEN_TTL_SECONDS;
  const accessToken = issueSignedPayload(tokenSecret, {
    v: 1,
    typ: "access",
    sub: input.githubUserId,
    login: input.githubLogin,
    cid: input.clientId,
    scp: input.scopes,
    res: input.resource,
    iat: now,
    exp: accessExp,
  });
  const refreshToken = issueSignedPayload(tokenSecret, {
    v: 1,
    typ: "refresh",
    sub: input.githubUserId,
    login: input.githubLogin,
    cid: input.clientId,
    scp: input.scopes,
    res: input.resource,
    iat: now,
    exp: refreshExp,
  });
  return {
    accessToken,
    accessTokenExpiresAt: new Date(accessExp * 1000),
    refreshToken,
    refreshTokenExpiresAt: new Date(refreshExp * 1000),
    scopes: input.scopes,
  };
}

export interface ValidatedAccessToken {
  clientId: string;
  githubUserId: number;
  githubLogin: string;
  scopes: string[];
  resource: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function validateAccessToken(
  tokenSecret: string,
  token: string,
  expectedResource: string,
): ValidatedAccessToken | null {
  const payload = verifySignedPayload(tokenSecret, token, "access");
  if (!payload) return null;
  if (payload.res !== expectedResource) return null;
  if (typeof payload.sub !== "number" || !payload.login || !payload.cid) {
    return null;
  }
  return {
    clientId: payload.cid,
    githubUserId: payload.sub,
    githubLogin: payload.login,
    scopes: payload.scp ?? [],
    resource: payload.res ?? "",
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
  };
}

export function createAuthorizationCode(
  tokenSecret: string,
  input: {
    clientId: string;
    githubUserId: number;
    githubLogin: string;
    redirectUri: string;
    scopes: string[];
    resource: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  },
): string {
  const now = nowSeconds();
  return issueSignedPayload(tokenSecret, {
    v: 1,
    typ: "code",
    sub: input.githubUserId,
    login: input.githubLogin,
    cid: input.clientId,
    ruri: input.redirectUri,
    scp: input.scopes,
    res: input.resource,
    cc: input.codeChallenge,
    ccm: input.codeChallengeMethod,
    iat: now,
    exp: now + AUTHORIZATION_CODE_TTL_SECONDS,
  });
}

export function redeemAuthorizationCode(
  tokenSecret: string,
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
  },
):
  | { ok: true; githubUserId: number; githubLogin: string; scopes: string[] }
  | { ok: false; error: string } {
  const payload = verifySignedPayload(tokenSecret, input.code, "code");
  if (!payload) return { ok: false, error: "invalid_grant" };
  if (payload.cid !== input.clientId) return { ok: false, error: "invalid_grant" };
  if (payload.ruri !== input.redirectUri) {
    return { ok: false, error: "invalid_grant" };
  }
  if (payload.res !== input.resource) return { ok: false, error: "invalid_grant" };
  if (!payload.cc || !payload.ccm) return { ok: false, error: "invalid_grant" };
  if (!verifyPkce(input.codeVerifier, payload.cc, payload.ccm)) {
    return { ok: false, error: "invalid_grant" };
  }
  if (typeof payload.sub !== "number" || !payload.login) {
    return { ok: false, error: "invalid_grant" };
  }
  return {
    ok: true,
    githubUserId: payload.sub,
    githubLogin: payload.login,
    scopes: payload.scp ?? [],
  };
}

export function rotateRefreshToken(
  tokenSecret: string,
  input: { refreshToken: string; clientId: string; resource: string },
): { ok: true; tokens: IssuedTokens } | { ok: false; error: string } {
  const payload = verifySignedPayload(tokenSecret, input.refreshToken, "refresh");
  if (!payload) return { ok: false, error: "invalid_grant" };
  if (payload.cid !== input.clientId || payload.res !== input.resource) {
    return { ok: false, error: "invalid_grant" };
  }
  if (typeof payload.sub !== "number" || !payload.login) {
    return { ok: false, error: "invalid_grant" };
  }
  return {
    ok: true,
    tokens: issueTokens(tokenSecret, {
      clientId: payload.cid,
      githubUserId: payload.sub,
      githubLogin: payload.login,
      scopes: payload.scp ?? [],
      resource: payload.res ?? "",
    }),
  };
}
