import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let dbStatus: "ok" | "unavailable" = "ok";
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    dbStatus = "unavailable";
  }
  const config = getConfig();
  const body = {
    status: dbStatus === "ok" ? "ok" : "degraded",
    database: dbStatus,
    github_app_configured: Boolean(
      config.GITHUB_APP_ID &&
        config.GITHUB_APP_INSTALLATION_ID &&
        config.GITHUB_APP_PRIVATE_KEY,
    ),
    github_oauth_configured: Boolean(
      config.GITHUB_OAUTH_CLIENT_ID && config.GITHUB_OAUTH_CLIENT_SECRET,
    ),
    writes_enabled: config.writesEnabled,
    environment: config.VERCEL_ENV ?? "local",
    time: new Date().toISOString(),
  };
  return new Response(JSON.stringify(body), {
    status: dbStatus === "ok" ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
