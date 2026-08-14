import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import { attemptEdges, attempts } from "../db/schema";

export interface FrontierEntry {
  attempt_id: string;
  kind: string;
  title: string;
  summary: string;
  author_github_login: string;
  created_at: string;
  verification_status: string;
  relevance_status: string;
  solves_target: boolean;
  bucket:
    | "VERIFIED"
    | "REPRODUCED"
    | "UNVERIFIED"
    | "DISPUTED"
    | "REFUTED"
    | "BLOCKED"
    | "OPEN_SUBGOAL";
  referenced_by_count: number;
}

function bucketFor(attempt: {
  verificationStatus: string;
  kind: string;
  solvesTarget: boolean;
}): FrontierEntry["bucket"] {
  switch (attempt.verificationStatus) {
    case "lean_verified":
      return "VERIFIED";
    case "reproduced":
      return "REPRODUCED";
    case "disputed":
      return "DISPUTED";
    case "refuted":
      return "REFUTED";
    default:
      break;
  }
  if (attempt.kind === "refutation" || attempt.kind === "counterexample") {
    return "BLOCKED";
  }
  if (attempt.kind === "lemma" || attempt.kind === "reduction") {
    return "OPEN_SUBGOAL";
  }
  return "UNVERIFIED";
}

function bucketRank(bucket: FrontierEntry["bucket"]): number {
  switch (bucket) {
    case "VERIFIED":
      return 0;
    case "REPRODUCED":
      return 1;
    case "OPEN_SUBGOAL":
      return 2;
    case "BLOCKED":
      return 3;
    case "DISPUTED":
      return 4;
    case "REFUTED":
      return 5;
    case "UNVERIFIED":
      return 6;
  }
}

export async function buildFrontier(
  db: AnyDatabase,
  input: { problemKey: string; maxChars: number },
): Promise<{ frontier: FrontierEntry[]; truncated: boolean }> {
  const rows = await db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.problemKey, input.problemKey),
        eq(attempts.status, "merged"),
      ),
    )
    .orderBy(desc(attempts.mergedAt))
    .limit(500);
  const visible = rows.filter(
    (a) => a.verificationStatus !== "quarantined",
  );
  const ids = visible.map((a) => a.attemptId);
  const refCounts = new Map<string, number>();
  if (ids.length > 0) {
    const refs = await db
      .select({
        parentAttemptId: attemptEdges.parentAttemptId,
        count: sql<number>`count(*)::int`,
      })
      .from(attemptEdges)
      .where(inArray(attemptEdges.parentAttemptId, ids))
      .groupBy(attemptEdges.parentAttemptId);
    for (const r of refs) refCounts.set(r.parentAttemptId, r.count);
  }

  const entries: FrontierEntry[] = visible.map((a) => ({
    attempt_id: a.attemptId,
    kind: a.kind,
    title: a.title,
    summary: a.summary,
    author_github_login: a.ownerGithubLogin,
    created_at: a.createdAt.toISOString(),
    verification_status: a.verificationStatus,
    relevance_status: a.relevanceStatus,
    solves_target: a.solvesTarget && a.verificationStatus === "lean_verified",
    bucket: bucketFor(a),
    referenced_by_count: refCounts.get(a.attemptId) ?? 0,
  }));

  entries.sort((a, b) => {
    const rankDiff = bucketRank(a.bucket) - bucketRank(b.bucket);
    if (rankDiff !== 0) return rankDiff;
    if (b.referenced_by_count !== a.referenced_by_count) {
      return b.referenced_by_count - a.referenced_by_count;
    }
    return b.created_at.localeCompare(a.created_at);
  });

  const withinBudget: FrontierEntry[] = [];
  let used = 0;
  let truncated = false;
  for (const entry of entries) {
    const cost = 220 + entry.summary.length + entry.title.length;
    if (used + cost > input.maxChars && withinBudget.length > 0) {
      truncated = true;
      break;
    }
    withinBudget.push(entry);
    used += cost;
  }
  return { frontier: withinBudget, truncated };
}
