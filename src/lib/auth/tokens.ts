import { createHash, timingSafeEqual } from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthRefreshTokens,
} from "../db/schema";
import { hmacSha256Hex, randomToken } from "../ids";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60 * 5;
export const UPSTREAM_STATE_TTL_SECONDS = 60 * 10;

export function hashToken(tokenSecret: string, token: string): string {
  return hmacSha256Hex(tokenSecret, token);
}

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  if (method !== "S256") return false;
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export async function issueTokens(
  db: AnyDatabase,
  tokenSecret: string,
  input: {
    clientId: string;
    githubUserId: number;
    scopes: string[];
    resource: string;
  },
): Promise<IssuedTokens> {
  const accessToken = `ifu_${randomToken(32)}`;
  const refreshToken = `ifr_${randomToken(32)}`;
  const now = Date.now();
  const accessTokenExpiresAt = new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(
    now + REFRESH_TOKEN_TTL_SECONDS * 1000,
  );
  const accessTokenHash = hashToken(tokenSecret, accessToken);
  const refreshTokenHash = hashToken(tokenSecret, refreshToken);
  await db.insert(oauthAccessTokens).values({
    tokenHash: accessTokenHash,
    clientId: input.clientId,
    githubUserId: input.githubUserId,
    scopes: input.scopes,
    resource: input.resource,
    expiresAt: accessTokenExpiresAt,
  });
  await db.insert(oauthRefreshTokens).values({
    tokenHash: refreshTokenHash,
    accessTokenHash,
    clientId: input.clientId,
    githubUserId: input.githubUserId,
    scopes: input.scopes,
    resource: input.resource,
    expiresAt: refreshTokenExpiresAt,
  });
  return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
}

export interface ValidatedAccessToken {
  tokenHash: string;
  clientId: string;
  githubUserId: number;
  scopes: string[];
  resource: string;
  expiresAt: Date;
}

export async function validateAccessToken(
  db: AnyDatabase,
  tokenSecret: string,
  token: string,
): Promise<ValidatedAccessToken | null> {
  const tokenHash = hashToken(tokenSecret, token);
  const rows = await db
    .select()
    .from(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    tokenHash: row.tokenHash,
    clientId: row.clientId,
    githubUserId: row.githubUserId,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: row.expiresAt,
  };
}

export async function createAuthorizationCode(
  db: AnyDatabase,
  tokenSecret: string,
  input: {
    clientId: string;
    githubUserId: number;
    redirectUri: string;
    scopes: string[];
    resource: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  },
): Promise<string> {
  const code = `ifc_${randomToken(32)}`;
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: hashToken(tokenSecret, code),
    clientId: input.clientId,
    githubUserId: input.githubUserId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    resource: input.resource,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
  });
  return code;
}

export async function redeemAuthorizationCode(
  db: AnyDatabase,
  tokenSecret: string,
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
  },
): Promise<
  | { ok: true; githubUserId: number; scopes: string[] }
  | { ok: false; error: string }
> {
  const codeHash = hashToken(tokenSecret, input.code);
  const rows = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, error: "invalid_grant" };
  if (row.usedAt) return { ok: false, error: "invalid_grant" };
  if (row.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "invalid_grant" };
  }
  if (row.clientId !== input.clientId) {
    return { ok: false, error: "invalid_grant" };
  }
  if (row.redirectUri !== input.redirectUri) {
    return { ok: false, error: "invalid_grant" };
  }
  if (row.resource !== input.resource) {
    return { ok: false, error: "invalid_grant" };
  }
  if (!verifyPkce(input.codeVerifier, row.codeChallenge, row.codeChallengeMethod)) {
    return { ok: false, error: "invalid_grant" };
  }
  await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash));
  return {
    ok: true,
    githubUserId: row.githubUserId,
    scopes: row.scopes,
  };
}

export async function rotateRefreshToken(
  db: AnyDatabase,
  tokenSecret: string,
  input: { refreshToken: string; clientId: string; resource: string },
): Promise<
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; error: string }
> {
  const tokenHash = hashToken(tokenSecret, input.refreshToken);
  const rows = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, error: "invalid_grant" };
  if (row.revokedAt || row.rotatedToHash) {
    await revokeTokenFamily(db, row.accessTokenHash);
    if (row.rotatedToHash) {
      const successors = await db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, row.rotatedToHash))
        .limit(1);
      const successor = successors[0];
      if (successor) {
        await revokeTokenFamily(db, successor.accessTokenHash);
        await db
          .update(oauthRefreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(oauthRefreshTokens.tokenHash, successor.tokenHash));
      }
    }
    return { ok: false, error: "invalid_grant" };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "invalid_grant" };
  }
  if (row.clientId !== input.clientId || row.resource !== input.resource) {
    return { ok: false, error: "invalid_grant" };
  }
  const tokens = await issueTokens(db, tokenSecret, {
    clientId: row.clientId,
    githubUserId: row.githubUserId,
    scopes: row.scopes,
    resource: row.resource,
  });
  await db
    .update(oauthRefreshTokens)
    .set({ rotatedToHash: hashToken(tokenSecret, tokens.refreshToken) })
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: new Date() })
    .where(eq(oauthAccessTokens.tokenHash, row.accessTokenHash));
  return { ok: true, tokens };
}

async function revokeTokenFamily(
  db: AnyDatabase,
  accessTokenHash: string,
): Promise<void> {
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: new Date() })
    .where(eq(oauthAccessTokens.tokenHash, accessTokenHash));
}

export async function revokeToken(
  db: AnyDatabase,
  tokenSecret: string,
  token: string,
): Promise<void> {
  const tokenHash = hashToken(tokenSecret, token);
  const now = new Date();
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(eq(oauthAccessTokens.tokenHash, tokenHash));
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
}

export async function revokeAllUserTokens(
  db: AnyDatabase,
  githubUserId: number,
): Promise<void> {
  const now = new Date();
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthAccessTokens.githubUserId, githubUserId),
        isNull(oauthAccessTokens.revokedAt),
      ),
    );
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthRefreshTokens.githubUserId, githubUserId),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    );
}
