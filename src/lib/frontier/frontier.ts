import type { AnyContext, AttemptRecord } from "../attempts/service";
import {
  deriveVerificationView,
  readAllAttestations,
} from "../attestations";
import { parseManifest } from "../attempts/manifest";

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

function bucketFor(input: {
  verificationStatus: string;
  kind: string;
}): FrontierEntry["bucket"] {
  switch (input.verificationStatus) {
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
  if (input.kind === "refutation" || input.kind === "counterexample") {
    return "BLOCKED";
  }
  if (input.kind === "lemma" || input.kind === "reduction") {
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

export interface MergedAttemptIndex {
  attempts: AttemptRecord[];
  edges: Array<{ child: string; parent: string; relationship: string }>;
  treeSha: string;
}

const indexCache = new Map<
  string,
  { treeSha: string; value: MergedAttemptIndex; fetchedAt: number }
>();
const INDEX_CACHE_TTL_MS = 60 * 1000;

export async function buildMergedAttemptIndex(
  ctx: AnyContext,
  problemKey: string,
): Promise<MergedAttemptIndex> {
  const { sha, tree } = await ctx.github.getTreeRecursive(ctx.progressBranch);
  const cached = indexCache.get(problemKey);
  if (
    cached &&
    cached.treeSha === sha &&
    Date.now() - cached.fetchedAt < INDEX_CACHE_TTL_MS
  ) {
    return cached.value;
  }
  const prefix = `attempts/${problemKey}/`;
  const manifestPaths = tree
    .map((t) => t.path)
    .filter(
      (p) => p.startsWith(prefix) && p.endsWith("/manifest.json"),
    );
  const files = await ctx.github.readFilesAtRef(sha, manifestPaths);
  const attempts: AttemptRecord[] = [];
  const edges: MergedAttemptIndex["edges"] = [];
  for (const [path, content] of files) {
    const attemptId = path.split("/")[2] ?? "";
    try {
      const manifest = parseManifest(JSON.parse(content));
      attempts.push({
        attemptId: manifest.attempt_id,
        problemKey,
        ownerGithubUserId: manifest.author.github_user_id,
        ownerGithubLogin: manifest.author.github_login,
        kind: manifest.kind,
        title: manifest.title,
        summary: manifest.summary,
        branchName: null,
        baseProgressSha: manifest.base_progress_sha,
        status: "merged",
        hasLean: manifest.declared_lean_theorems.length > 0,
        solvesTarget: manifest.solves_target,
        parents: manifest.parents,
        createdAt: manifest.created_at,
        prNumber: null,
        prUrl: null,
        mergedAt: null,
        manifest,
      });
      for (const parent of manifest.parents) {
        edges.push({
          child: manifest.attempt_id,
          parent: parent.attempt_id,
          relationship: parent.relationship,
        });
      }
    } catch {
      continue;
    }
    void attemptId;
  }
  const value = { attempts, edges, treeSha: sha };
  indexCache.set(problemKey, {
    treeSha: sha,
    value,
    fetchedAt: Date.now(),
  });
  return value;
}

export function clearFrontierCacheForTests(): void {
  indexCache.clear();
}

export async function buildFrontier(
  ctx: AnyContext,
  input: { problemKey: string; maxChars: number },
): Promise<{ frontier: FrontierEntry[]; truncated: boolean }> {
  const index = await buildMergedAttemptIndex(ctx, input.problemKey);
  const attestations = await readAllAttestations(
    ctx.github,
    ctx.progressBranch,
  );

  const refCounts = new Map<string, number>();
  for (const edge of index.edges) {
    refCounts.set(edge.parent, (refCounts.get(edge.parent) ?? 0) + 1);
  }

  const entries: FrontierEntry[] = [];
  for (const attempt of index.attempts) {
    const view = deriveVerificationView(
      attempt.attemptId,
      attestations,
      index.edges,
    );
    if (view.quarantined) continue;
    entries.push({
      attempt_id: attempt.attemptId,
      kind: attempt.kind,
      title: attempt.title,
      summary: attempt.summary,
      author_github_login: attempt.ownerGithubLogin,
      created_at: attempt.createdAt,
      verification_status: view.verificationStatus,
      relevance_status:
        attempt.solvesTarget && view.verificationStatus === "lean_verified"
          ? "solves_target"
          : "unreviewed",
      solves_target:
        attempt.solvesTarget && view.verificationStatus === "lean_verified",
      bucket: bucketFor({
        verificationStatus: view.verificationStatus,
        kind: attempt.kind,
      }),
      referenced_by_count: refCounts.get(attempt.attemptId) ?? 0,
    });
  }

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
