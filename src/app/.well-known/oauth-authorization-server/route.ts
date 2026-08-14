import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const config = getConfig();
  const base = config.INFERFUND_BASE_URL;
  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [
      "inferfund:read",
      "inferfund:contribute",
      "inferfund:admin",
    ],
    client_id_metadata_document_supported: true,
    resource_documentation: `${base}/`,
  };
  return new Response(JSON.stringify(metadata), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}
