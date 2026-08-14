export type AuditActorKind =
  | "user"
  | "admin"
  | "service"
  | "system"
  | "verifier"
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

export function audit(event: {
  actorGithubUserId?: number;
  actorKind: AuditActorKind;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}): void {
  const record = {
    ts: new Date().toISOString(),
    kind: "inferfund_audit",
    actor: event.actorGithubUserId ?? null,
    actor_kind: event.actorKind,
    action: event.action,
    target_type: event.targetType ?? null,
    target_id: event.targetId ?? null,
    details: sanitize(event.details) ?? null,
  };
  console.log(JSON.stringify(record));
}
