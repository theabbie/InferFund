import { randomUUID } from "node:crypto";
import type { AnyDatabase } from "../db/client";
import { auditEvents } from "../db/schema";

export type AuditActorKind =
  | "user"
  | "admin"
  | "service"
  | "system"
  | "anonymous";

const SENSITIVE_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "code",
  "client_secret",
  "private_key",
  "authorization",
]);

function sanitize(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    clean[key] =
      typeof value === "string" && value.length > 2000
        ? value.slice(0, 2000)
        : value;
  }
  return clean;
}

export async function audit(
  db: AnyDatabase,
  event: {
    actorGithubUserId?: number;
    actorKind: AuditActorKind;
    action: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
    ipHash?: string;
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    id: randomUUID(),
    actorGithubUserId: event.actorGithubUserId,
    actorKind: event.actorKind,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    details: sanitize(event.details),
    ipHash: event.ipHash,
  });
}
