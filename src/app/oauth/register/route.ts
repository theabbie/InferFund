import { registerClient } from "@/lib/auth/clients";
import { jsonResponse, oauthError } from "@/lib/auth/authenticate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthError(400, "invalid_client_metadata", "Body must be JSON.");
  }
  const result = await registerClient(body);
  if (!result.ok) {
    const response = oauthError(400, result.error, result.description);
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
    return response;
  }
  const response = jsonResponse(
    201,
    {
      client_id: result.client.clientId,
      client_name: result.client.clientName ?? undefined,
      redirect_uris: result.client.redirectUris,
      grant_types: result.client.grantTypes,
      token_endpoint_auth_method: "none",
    },
    CORS,
  );
  return response;
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
