import { getDb } from "@/lib/db/client";
import { getConfig } from "@/lib/config";
import { revokeToken } from "@/lib/auth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

export async function POST(req: Request): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  const token = params.get("token");
  if (token) {
    const config = getConfig();
    await revokeToken(getDb(), config.INFERFUND_TOKEN_SECRET, token);
  }
  return new Response(null, { status: 200, headers: CORS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
