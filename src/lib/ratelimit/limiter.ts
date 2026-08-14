import { sql } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import { rateLimitBuckets } from "../db/schema";
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

export function windowStartFor(
  windowSeconds: number,
  now: Date = new Date(),
): Date {
  const ms = Math.floor(now.getTime() / (windowSeconds * 1000)) *
    windowSeconds * 1000;
  return new Date(ms);
}

export async function consumeRateLimit(
  db: AnyDatabase,
  input: {
    subject: string;
    rule: RateLimitRule;
    limitOverride?: number;
    now?: Date;
  },
): Promise<{ remaining: number; resetAt: Date }> {
  const limit = input.limitOverride ?? input.rule.limit;
  const now = input.now ?? new Date();
  const windowStart = windowStartFor(input.rule.windowSeconds, now);
  const bucketKey = `${input.rule.name}:${input.subject}`;
  const rows = await db
    .insert(rateLimitBuckets)
    .values({ bucketKey, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.bucketKey, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });
  const count = rows[0]?.count ?? 1;
  const resetAt = new Date(
    windowStart.getTime() + input.rule.windowSeconds * 1000,
  );
  if (count > limit) {
    throw new InferFundError(
      "RATE_LIMITED",
      `Rate limit exceeded for ${input.rule.name}. Try again after ${resetAt.toISOString()}.`,
      {
        retryable: true,
        details: {
          limit_type: input.rule.name,
          limit,
          reset_at: resetAt.toISOString(),
        },
      },
    );
  }
  return { remaining: limit - count, resetAt };
}
