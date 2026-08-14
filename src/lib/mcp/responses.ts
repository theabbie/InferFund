import type { CallToolResult } from "@modelcontextprotocol/server";
import { InferFundError, toInferFundError } from "../errors";

export const TRUST_LABEL = "untrusted_contributor_content" as const;

export function untrusted<T extends Record<string, unknown>>(
  payload: T,
): T & { trust: typeof TRUST_LABEL } {
  return { trust: TRUST_LABEL, ...payload };
}

export function trusted<T extends Record<string, unknown>>(
  payload: T,
): T & { trust: "inferfund_server_metadata" } {
  return { trust: "inferfund_server_metadata", ...payload };
}

export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const err = toInferFundError(error);
  const expose = err instanceof InferFundError;
  const body = expose
    ? err.toJSON()
    : { code: "INTERNAL_ERROR", message: "Internal error.", retryable: true };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body as Record<string, unknown>,
  };
}
