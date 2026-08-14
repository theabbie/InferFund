import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { makeHarness, TEST_TOKEN_SECRET, ALICE } from "./setup";
import {
  createAuthorizationCode,
  issueTokens,
  redeemAuthorizationCode,
  revokeToken,
  rotateRefreshToken,
  validateAccessToken,
} from "../src/lib/auth/tokens";
import { registerClient, resolveClient } from "../src/lib/auth/clients";
import { oauthClients, users } from "../src/lib/db/schema";

async function seedUser(h: Awaited<ReturnType<typeof makeHarness>>) {
  await h.db.insert(users).values({
    githubUserId: ALICE.githubUserId,
    githubLogin: ALICE.githubLogin,
  });
  await h.db.insert(oauthClients).values({
    clientId: "ifd_test",
    kind: "dcr",
    redirectUris: ["https://client.example.com/cb"],
    grantTypes: ["authorization_code", "refresh_token"],
  });
}

function pkce() {
  const verifier = "correct-horse-battery-staple-" + "x".repeat(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("OAuth tokens", () => {
  it("issues and validates access tokens with resource binding", async () => {
    const h = await makeHarness();
    await seedUser(h);
    const tokens = await issueTokens(h.db, TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      scopes: ["inferfund:read", "inferfund:contribute"],
      resource: "https://inferfund.example.com/api/mcp",
    });
    const validated = await validateAccessToken(
      h.db,
      TEST_TOKEN_SECRET,
      tokens.accessToken,
    );
    expect(validated?.githubUserId).toBe(ALICE.githubUserId);
    expect(validated?.scopes).toContain("inferfund:contribute");
    expect(validated?.resource).toBe("https://inferfund.example.com/api/mcp");
  });

  it("rejects unknown and revoked tokens", async () => {
    const h = await makeHarness();
    await seedUser(h);
    expect(
      await validateAccessToken(h.db, TEST_TOKEN_SECRET, "ifu_nonexistent"),
    ).toBeNull();
    const tokens = await issueTokens(h.db, TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      scopes: ["inferfund:read"],
      resource: "https://inferfund.example.com/api/mcp",
    });
    await revokeToken(h.db, TEST_TOKEN_SECRET, tokens.accessToken);
    expect(
      await validateAccessToken(h.db, TEST_TOKEN_SECRET, tokens.accessToken),
    ).toBeNull();
  });

  it("authorization codes are single-use and PKCE-bound", async () => {
    const h = await makeHarness();
    await seedUser(h);
    const { verifier, challenge } = pkce();
    const code = await createAuthorizationCode(h.db, TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      redirectUri: "https://client.example.com/cb",
      scopes: ["inferfund:read"],
      resource: "https://inferfund.example.com/api/mcp",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const first = await redeemAuthorizationCode(h.db, TEST_TOKEN_SECRET, {
      code,
      clientId: "ifd_test",
      redirectUri: "https://client.example.com/cb",
      codeVerifier: verifier,
      resource: "https://inferfund.example.com/api/mcp",
    });
    expect(first.ok).toBe(true);
    const replay = await redeemAuthorizationCode(h.db, TEST_TOKEN_SECRET, {
      code,
      clientId: "ifd_test",
      redirectUri: "https://client.example.com/cb",
      codeVerifier: verifier,
      resource: "https://inferfund.example.com/api/mcp",
    });
    expect(replay.ok).toBe(false);
  });

  it("rejects bad PKCE verifier, wrong redirect URI, wrong client", async () => {
    const h = await makeHarness();
    await seedUser(h);
    const { verifier, challenge } = pkce();
    const mk = () =>
      createAuthorizationCode(h.db, TEST_TOKEN_SECRET, {
        clientId: "ifd_test",
        githubUserId: ALICE.githubUserId,
        redirectUri: "https://client.example.com/cb",
        scopes: ["inferfund:read"],
        resource: "https://inferfund.example.com/api/mcp",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
    const badVerifier = await redeemAuthorizationCode(
      h.db,
      TEST_TOKEN_SECRET,
      {
        code: await mk(),
        clientId: "ifd_test",
        redirectUri: "https://client.example.com/cb",
        codeVerifier: "wrong" + verifier.slice(5),
        resource: "https://inferfund.example.com/api/mcp",
      },
    );
    expect(badVerifier.ok).toBe(false);
    const badRedirect = await redeemAuthorizationCode(
      h.db,
      TEST_TOKEN_SECRET,
      {
        code: await mk(),
        clientId: "ifd_test",
        redirectUri: "https://evil.example.com/cb",
        codeVerifier: verifier,
        resource: "https://inferfund.example.com/api/mcp",
      },
    );
    expect(badRedirect.ok).toBe(false);
    const badClient = await redeemAuthorizationCode(h.db, TEST_TOKEN_SECRET, {
      code: await mk(),
      clientId: "ifd_other",
      redirectUri: "https://client.example.com/cb",
      codeVerifier: verifier,
      resource: "https://inferfund.example.com/api/mcp",
    });
    expect(badClient.ok).toBe(false);
  });

  it("refresh tokens rotate and old access tokens are revoked", async () => {
    const h = await makeHarness();
    await seedUser(h);
    const tokens = await issueTokens(h.db, TEST_TOKEN_SECRET, {
      clientId: "ifd_test",
      githubUserId: ALICE.githubUserId,
      scopes: ["inferfund:read"],
      resource: "https://inferfund.example.com/api/mcp",
    });
    const rotated = await rotateRefreshToken(h.db, TEST_TOKEN_SECRET, {
      refreshToken: tokens.refreshToken,
      clientId: "ifd_test",
      resource: "https://inferfund.example.com/api/mcp",
    });
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      expect(rotated.tokens.accessToken).not.toBe(tokens.accessToken);
    }
    expect(
      await validateAccessToken(h.db, TEST_TOKEN_SECRET, tokens.accessToken),
    ).toBeNull();
    const replay = await rotateRefreshToken(h.db, TEST_TOKEN_SECRET, {
      refreshToken: tokens.refreshToken,
      clientId: "ifd_test",
      resource: "https://inferfund.example.com/api/mcp",
    });
    expect(replay.ok).toBe(false);
    if (rotated.ok) {
      expect(
        await validateAccessToken(
          h.db,
          TEST_TOKEN_SECRET,
          rotated.tokens.accessToken,
        ),
      ).toBeNull();
    }
  });
});

describe("OAuth client registration (DCR + CIMD)", () => {
  it("registers a client via DCR with https redirect URIs", async () => {
    const h = await makeHarness();
    const result = await registerClient(h.db, {
      client_name: "Test Client",
      redirect_uris: ["https://client.example.com/callback"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.clientId).toMatch(/^ifd_/);
      const resolved = await resolveClient(h.db, result.client.clientId);
      expect(resolved?.redirectUris).toEqual([
        "https://client.example.com/callback",
      ]);
    }
  });

  it("rejects DCR with non-loopback http redirect URIs", async () => {
    const h = await makeHarness();
    const result = await registerClient(h.db, {
      redirect_uris: ["http://evil.example.com/cb"],
    });
    expect(result.ok).toBe(false);
  });

  it("allows loopback http redirect URIs", async () => {
    const h = await makeHarness();
    const result = await registerClient(h.db, {
      redirect_uris: ["http://localhost:3333/callback"],
    });
    expect(result.ok).toBe(true);
  });

  it("resolves a CIMD client from its metadata URL", async () => {
    const h = await makeHarness();
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
      h.db,
      "https://client.example.com/mcp.json",
      fetchImpl as typeof fetch,
    );
    expect(client?.clientName).toBe("CIMD Client");
  });

  it("rejects CIMD documents whose client_id does not match the URL", async () => {
    const h = await makeHarness();
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          client_id: "https://different.example.com/x.json",
          redirect_uris: ["https://client.example.com/cb"],
        }),
        { status: 200 },
      );
    const client = await resolveClient(
      h.db,
      "https://client.example.com/mcp.json",
      fetchImpl as typeof fetch,
    );
    expect(client).toBeNull();
  });
});
