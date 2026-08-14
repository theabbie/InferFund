import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig } from "../config";

const cimdMetadataSchema = z.object({
  client_id: z.string().url(),
  client_name: z.string().max(256).optional(),
  client_uri: z.string().url().optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(32),
  grant_types: z.array(z.string()).optional(),
});

const dcrRequestSchema = z.object({
  client_name: z.string().max(256).optional(),
  client_uri: z.string().url().optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(32),
  grant_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export interface RegisteredClient {
  clientId: string;
  clientName?: string | null;
  redirectUris: string[];
  grantTypes: string[];
}

function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]")
  ) {
    return true;
  }
  return false;
}

function signClientBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

const cimdCache = new Map<
  string,
  { client: RegisteredClient | null; expiresAt: number }
>();
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;
const CIMD_CACHE_MAX = 500;

async function resolveCimdClient(
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<RegisteredClient | null> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  try {
    response = await fetchImpl(clientId, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch {
    clearTimeout(timeout);
    return null;
  }
  clearTimeout(timeout);
  if (!response.ok) return null;
  let raw: unknown;
  try {
    const text = await response.text();
    if (text.length > 16 * 1024) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const metadata = cimdMetadataSchema.safeParse(raw);
  if (!metadata.success) return null;
  if (metadata.data.client_id !== clientId) return null;
  if (!metadata.data.redirect_uris.every(isAllowedRedirectUri)) return null;
  const client: RegisteredClient = {
    clientId,
    clientName: metadata.data.client_name ?? null,
    redirectUris: metadata.data.redirect_uris,
    grantTypes: metadata.data.grant_types ?? [
      "authorization_code",
      "refresh_token",
    ],
  };
  if (cimdCache.size >= CIMD_CACHE_MAX) cimdCache.clear();
  cimdCache.set(clientId, {
    client,
    expiresAt: Date.now() + CIMD_CACHE_TTL_MS,
  });
  return client;
}

function resolveDcrClient(
  clientId: string,
  secret: string,
): RegisteredClient | null {
  if (!clientId.startsWith("ifd_")) return null;
  const rest = clientId.slice(4);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);
  const expected = signClientBody(secret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const schema = z.object({
    v: z.literal(1),
    name: z.string().max(256).nullable(),
    ruris: z.array(z.string().max(2048)).min(1).max(32),
    gts: z.array(z.string()),
    iat: z.number(),
  });
  const valid = schema.safeParse(parsed);
  if (!valid.success) return null;
  if (!valid.data.ruris.every(isAllowedRedirectUri)) return null;
  return {
    clientId,
    clientName: valid.data.name,
    redirectUris: valid.data.ruris,
    grantTypes: valid.data.gts,
  };
}

export async function resolveClient(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisteredClient | null> {
  const config = getConfig();
  if (clientId.startsWith("ifd_")) {
    return resolveDcrClient(clientId, config.INFERFUND_TOKEN_SECRET);
  }
  if (clientId.startsWith("https://")) {
    return resolveCimdClient(clientId, fetchImpl);
  }
  return null;
}

export async function registerClient(
  body: unknown,
): Promise<
  | { ok: true; client: RegisteredClient }
  | { ok: false; error: string; description: string }
> {
  const parsed = dcrRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "redirect_uris (non-empty array) is required.",
    };
  }
  if (!parsed.data.redirect_uris.every(isAllowedRedirectUri)) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: "redirect_uris must use https, or http with a loopback host.",
    };
  }
  const config = getConfig();
  const grantTypes = parsed.data.grant_types ?? [
    "authorization_code",
    "refresh_token",
  ];
  const payload = {
    v: 1 as const,
    name: parsed.data.client_name ?? null,
    ruris: parsed.data.redirect_uris,
    gts: grantTypes,
    iat: Math.floor(Date.now() / 1000),
  };
  const bodyEncoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const clientId = `ifd_${bodyEncoded}.${signClientBody(config.INFERFUND_TOKEN_SECRET, bodyEncoded)}`;
  return {
    ok: true,
    client: {
      clientId,
      clientName: parsed.data.client_name ?? null,
      redirectUris: parsed.data.redirect_uris,
      grantTypes,
    },
  };
}

export function validateRedirectUri(
  client: RegisteredClient,
  redirectUri: string,
): boolean {
  return client.redirectUris.includes(redirectUri);
}

export function clearCimdCacheForTests(): void {
  cimdCache.clear();
}
