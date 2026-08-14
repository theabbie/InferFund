import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const config = getConfig();
  return protectedResourceHandler({
    authServerUrls: [config.INFERFUND_BASE_URL],
    resourceUrl: config.INFERFUND_MCP_RESOURCE_URL,
  })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
