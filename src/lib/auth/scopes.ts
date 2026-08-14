export const SCOPES = {
  READ: "inferfund:read",
  CONTRIBUTE: "inferfund:contribute",
  ADMIN: "inferfund:admin",
} as const;

export const DEFAULT_GRANTED_SCOPES: readonly string[] = [
  SCOPES.READ,
  SCOPES.CONTRIBUTE,
];

export const ALL_SCOPES: readonly string[] = [
  SCOPES.READ,
  SCOPES.CONTRIBUTE,
  SCOPES.ADMIN,
];

export function parseScopeString(scope: string | undefined): string[] {
  if (!scope) return [...DEFAULT_GRANTED_SCOPES];
  return scope.split(" ").filter((s) => s.length > 0);
}

export function filterGrantableScopes(
  requested: string[],
  adminGithubIds: ReadonlySet<number>,
  githubUserId: number,
): string[] | null {
  const granted: string[] = [];
  for (const scope of requested) {
    if (!(ALL_SCOPES as readonly string[]).includes(scope)) return null;
    if (scope === SCOPES.ADMIN) {
      if (!adminGithubIds.has(githubUserId)) continue;
    }
    granted.push(scope);
  }
  if (granted.length === 0) return [...DEFAULT_GRANTED_SCOPES];
  return [...new Set(granted)];
}

export function hasScope(granted: string[], required: string): boolean {
  return granted.includes(required);
}
