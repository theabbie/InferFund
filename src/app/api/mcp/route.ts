import { mcpHandler } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export { mcpHandler as GET, mcpHandler as POST, mcpHandler as DELETE };
