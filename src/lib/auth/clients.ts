import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import { oauthClients } from "../db/schema";
import { randomToken } from "../ids";

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

export async function resolveClient(
  db: AnyDatabase,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisteredClient | null> {
  const existing = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  if (existing[0]) {
    return {
      clientId: existing[0].clientId,
      clientName: existing[0].clientName,
      redirectUris: existing[0].redirectUris,
      grantTypes: existing[0].grantTypes,
    };
  }
  if (!clientId.startsWith("https://")) return null;
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
  const grantTypes = metadata.data.grant_types ?? [
    "authorization_code",
    "refresh_token",
  ];
  await db
    .insert(oauthClients)
    .values({
      clientId,
      kind: "cimd",
      clientName: metadata.data.client_name ?? null,
      clientUri: metadata.data.client_uri ?? null,
      redirectUris: metadata.data.redirect_uris,
      grantTypes,
      metadataFetchedAt: new Date(),
    })
    .onConflictDoNothing();
  return {
    clientId,
    clientName: metadata.data.client_name ?? null,
    redirectUris: metadata.data.redirect_uris,
    grantTypes,
  };
}

export async function registerClient(
  db: AnyDatabase,
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
      description:
        "redirect_uris must use https, or http with a loopback host.",
    };
  }
  const clientId = `ifd_${randomToken(24)}`;
  const grantTypes = parsed.data.grant_types ?? [
    "authorization_code",
    "refresh_token",
  ];
  await db.insert(oauthClients).values({
    clientId,
    kind: "dcr",
    clientName: parsed.data.client_name ?? null,
    clientUri: parsed.data.client_uri ?? null,
    redirectUris: parsed.data.redirect_uris,
    grantTypes,
  });
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
