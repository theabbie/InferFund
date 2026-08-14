import { InferFundError } from "../errors";

export interface RateLimitRule {
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  readPerMinute: { name: "read", limit: 60, windowSeconds: 60 },
  searchPerMinute: { name: "search", limit: 30, windowSeconds: 60 },
  attemptCreatePerDay: {
    name: "attempt_create",
    limit: 5,
    windowSeconds: 86400,
  },
  attemptUpdatePerHour: {
    name: "attempt_update",
    limit: 60,
    windowSeconds: 3600,
  },
  submissionPerDay: { name: "submission", limit: 10, windowSeconds: 86400 },
  leanSubmissionPerDay: {
    name: "lean_submission",
    limit: 5,
    windowSeconds: 86400,
  },
  reportPerDay: { name: "report", limit: 20, windowSeconds: 86400 },
} as const satisfies Record<string, RateLimitRule>;

interface Bucket {
  count: number;
  resetAtMs: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10000;

function gc(nowMs: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAtMs <= nowMs) buckets.delete(key);
  }
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

export function consumeRateLimit(
  subject: string,
  rule: RateLimitRule,
  options?: { limitOverride?: number; now?: Date },
): { remaining: number; resetAt: Date } {
  const limit = options?.limitOverride ?? rule.limit;
  const nowMs = options?.now?.getTime() ?? Date.now();
  gc(nowMs);
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const key = `${rule.name}:${subject}:${windowStart}`;
  const existing = buckets.get(key);
  const bucket: Bucket =
    existing && existing.resetAtMs > nowMs
      ? existing
      : { count: 0, resetAtMs: windowStart + windowMs };
  bucket.count += 1;
  buckets.set(key, bucket);
  const resetAt = new Date(bucket.resetAtMs);
  if (bucket.count > limit) {
    throw new InferFundError(
      "RATE_LIMITED",
      `Rate limit exceeded for ${rule.name}. Try again after ${resetAt.toISOString()}.`,
      {
        retryable: true,
        details: {
          limit_type: rule.name,
          limit,
          reset_at: resetAt.toISOString(),
        },
      },
    );
  }
  return { remaining: limit - bucket.count, resetAt };
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
