import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { TEST_TOKEN_SECRET, TEST_SESSION_SECRET, ALICE } from "./setup";
import {
  createAuthorizationCode,
  issueTokens,
  redeemAuthorizationCode,
  rotateRefreshToken,
  validateAccessToken,
} from "../src/lib/auth/tokens";
import {
  issueSignedPayload,
  nowSeconds,
  verifySignedPayload,
} from "../src/lib/auth/stateless";
import {
  registerClient,
  resolveClient,
  clearCimdCacheForTests,
  validateRedirectUri,
} from "../src/lib/auth/clients";
import { resetConfigCacheForTests } from "../src/lib/config";

const RESOURCE = "http://localhost:3000/api/mcp";

beforeEach(() => {
  process.env.INFERFUND_BASE_URL = "http://localhost:3000";
  process.env.INFERFUND_MCP_RESOURCE_URL = RESOURCE;
  process.env.INFERFUND_SESSION_SECRET = TEST_SESSION_SECRET;
  process.env.INFERFUND_TOKEN_SECRET = TEST_TOKEN_SECRET;
  process.env.GITHUB_REPO_OWNER = "fake";
  process.env.GITHUB_REPO_NAME = "repo";
  resetConfigCacheForTests();
  clearCimdCacheForTests();
});

function pkce() {
  const verifier = "correct-horse-battery-staple-" + "x".repeat(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("stateless OAuth tokens", () => {
  it("issues and validates access tokens with resource binding", () => {
    const tokens = issueTokens(TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      githubLogin: ALICE.githubLogin,
      scopes: ["inferfund:read", "inferfund:contribute"],
      resource: RESOURCE,
    });
    const validated = validateAccessToken(TEST_TOKEN_SECRET, tokens.accessToken, RESOURCE);
    expect(validated?.githubUserId).toBe(ALICE.githubUserId);
    expect(validated?.scopes).toContain("inferfund:contribute");
  });

  it("rejects tokens for a different resource (audience confusion)", () => {
    const tokens = issueTokens(TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      githubLogin: ALICE.githubLogin,
      scopes: ["inferfund:read"],
      resource: RESOURCE,
    });
    expect(
      validateAccessToken(
        TEST_TOKEN_SECRET,
        tokens.accessToken,
        "https://other.example.com/api/mcp",
      ),
    ).toBeNull();
  });

  it("rejects forged, tampered, and wrong-secret tokens", () => {
    const tokens = issueTokens(TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      githubLogin: ALICE.githubLogin,
      scopes: ["inferfund:read"],
      resource: RESOURCE,
    });
    expect(
      validateAccessToken("wrong-secret-wrong-secret-wrong-secre", tokens.accessToken, RESOURCE),
    ).toBeNull();
    const tampered = tokens.accessToken.replace(/.$/, "A");
    expect(validateAccessToken(TEST_TOKEN_SECRET, tampered, RESOURCE)).toBeNull();
    expect(validateAccessToken(TEST_TOKEN_SECRET, "garbage", RESOURCE)).toBeNull();
    expect(validateAccessToken(TEST_TOKEN_SECRET, tokens.refreshToken, RESOURCE)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const now = nowSeconds();
    const expired = issueSignedPayload(TEST_TOKEN_SECRET, {
      v: 1,
      typ: "access",
      sub: ALICE.githubUserId,
      login: ALICE.githubLogin,
      cid: "ifd_test",
      scp: ["inferfund:read"],
      res: RESOURCE,
      iat: now - 7200,
      exp: now - 3600,
    });
    expect(validateAccessToken(TEST_TOKEN_SECRET, expired, RESOURCE)).toBeNull();
  });

  it("authorization codes are PKCE-bound and expire", () => {
    const { verifier, challenge } = pkce();
    const code = createAuthorizationCode(TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      githubLogin: ALICE.githubLogin,
      redirectUri: "https://client.example.com/cb",
      scopes: ["inferfund:read"],
      resource: RESOURCE,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const ok = redeemAuthorizationCode(TEST_TOKEN_SECRET, {
      code,
      clientId: "ifd_test",
      redirectUri: "https://client.example.com/cb",
      codeVerifier: verifier,
      resource: RESOURCE,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.githubUserId).toBe(ALICE.githubUserId);
  });

  it("rejects bad PKCE verifier, wrong redirect URI, wrong client, wrong resource", () => {
    const { verifier, challenge } = pkce();
    const mk = () =>
      createAuthorizationCode(TEST_TOKEN_SECRET, {
        clientId: "ifd_test",
        githubUserId: ALICE.githubUserId,
        githubLogin: ALICE.githubLogin,
        redirectUri: "https://client.example.com/cb",
        scopes: ["inferfund:read"],
        resource: RESOURCE,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
    expect(
      redeemAuthorizationCode(TEST_TOKEN_SECRET, {
        code: mk(),
        clientId: "ifd_test",
        redirectUri: "https://client.example.com/cb",
        codeVerifier: "wrong" + verifier.slice(5),
        resource: RESOURCE,
      }).ok,
    ).toBe(false);
    expect(
      redeemAuthorizationCode(TEST_TOKEN_SECRET, {
        code: mk(),
        clientId: "ifd_test",
        redirectUri: "https://evil.example.com/cb",
        codeVerifier: verifier,
        resource: RESOURCE,
      }).ok,
    ).toBe(false);
    expect(
      redeemAuthorizationCode(TEST_TOKEN_SECRET, {
        code: mk(),
        clientId: "ifd_other",
        redirectUri: "https://client.example.com/cb",
        codeVerifier: verifier,
        resource: RESOURCE,
      }).ok,
    ).toBe(false);
    expect(
      redeemAuthorizationCode(TEST_TOKEN_SECRET, {
        code: mk(),
        clientId: "ifd_test",
        redirectUri: "https://client.example.com/cb",
        codeVerifier: verifier,
        resource: "https://evil.example.com/api/mcp",
      }).ok,
    ).toBe(false);
  });

  it("refresh tokens produce fresh token pairs", () => {
    const tokens = issueTokens(TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      githubLogin: ALICE.githubLogin,
      scopes: ["inferfund:read"],
      resource: RESOURCE,
    });
    const rotated = rotateRefreshToken(TEST_TOKEN_SECRET, {
      refreshToken: tokens.refreshToken,
      clientId: "ifd_test",
      resource: RESOURCE,
    });
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      expect(rotated.tokens.accessToken).not.toBe(tokens.accessToken);
      const validated = validateAccessToken(
        TEST_TOKEN_SECRET,
        rotated.tokens.accessToken,
        RESOURCE,
      );
      expect(validated?.githubUserId).toBe(ALICE.githubUserId);
    }
    expect(
      rotateRefreshToken(TEST_TOKEN_SECRET, {
        refreshToken: tokens.refreshToken,
        clientId: "ifd_other_client",
        resource: RESOURCE,
      }).ok,
    ).toBe(false);
  });

  it("upstream states are signed, typed, and expiring", () => {
    const now = nowSeconds();
    const state = issueSignedPayload(TEST_SESSION_SECRET, {
      v: 1,
      typ: "state",
      cid: "ifd_test",
      ruri: "https://client.example.com/cb",
      cstate: "client-state",
      scp: ["inferfund:read"],
      res: RESOURCE,
      cc: "challenge",
      ccm: "S256",
      iat: now,
      exp: now + 600,
    });
    const parsed = verifySignedPayload(TEST_SESSION_SECRET, state, "state");
    expect(parsed?.cstate).toBe("client-state");
    expect(verifySignedPayload(TEST_SESSION_SECRET, state, "code")).toBeNull();
    expect(
      verifySignedPayload("wrong-secret-wrong-secret-wrong-1234", state, "state"),
    ).toBeNull();
  });
});

describe("OAuth client registration (DCR + CIMD)", () => {
  it("registers a self-describing DCR client and resolves it back", async () => {
    const result = await registerClient({
      client_name: "Test Client",
      redirect_uris: ["https://client.example.com/callback"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.client.clientId).toMatch(/^ifd_/);
    const resolved = await resolveClient(result.client.clientId);
    expect(resolved?.clientName).toBe("Test Client");
    expect(
      validateRedirectUri(resolved!, "https://client.example.com/callback"),
    ).toBe(true);
    expect(
      validateRedirectUri(resolved!, "https://evil.example.com/cb"),
    ).toBe(false);
  });

  it("rejects DCR with non-loopback http redirect URIs", async () => {
    const result = await registerClient({
      redirect_uris: ["http://evil.example.com/cb"],
    });
    expect(result.ok).toBe(false);
  });

  it("allows loopback http redirect URIs", async () => {
    const result = await registerClient({
      redirect_uris: ["http://localhost:3333/callback"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects forged DCR client ids", async () => {
    const result = await registerClient({
      redirect_uris: ["https://client.example.com/cb"],
    });
    if (!result.ok) throw new Error("unreachable");
    const last = result.client.clientId.slice(-1);
    const forged =
      result.client.clientId.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(await resolveClient(forged)).toBeNull();
    const body = result.client.clientId.slice(4);
    const dot = body.lastIndexOf(".");
    const mutatedBody =
      body.slice(0, dot).replace(/.$/, (c) => (c === "A" ? "B" : "A")) +
      body.slice(dot);
    expect(await resolveClient(`ifd_${mutatedBody}`)).toBeNull();
  });

  it("resolves a CIMD client from its metadata URL", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          client_id: "https://client.example.com/mcp.json",
          client_name: "CIMD Client",
          redirect_uris: ["https://client.example.com/cb"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = await resolveClient(
      "https://client.example.com/mcp.json",
      fetchImpl as typeof fetch,
    );
    expect(client?.clientName).toBe("CIMD Client");
  });

  it("rejects CIMD documents whose client_id does not match the URL", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          client_id: "https://different.example.com/x.json",
          redirect_uris: ["https://client.example.com/cb"],
        }),
        { status: 200 },
      );
    const client = await resolveClient(
      "https://client.example.com/mcp.json",
      fetchImpl as typeof fetch,
    );
    expect(client).toBeNull();
  });
});
