import { and, eq, sql } from "drizzle-orm";
import type { AnyDatabase } from "../db/client";
import {
  attemptEdges,
  attemptFiles,
  attempts,
  idempotencyKeys,
  problems,
  problemVersions,
  users,
} from "../db/schema";
import { InferFundError } from "../errors";
import {
  attemptBranchName,
  attemptDirectory,
  contentHash,
  newAttemptId,
} from "../ids";
import type { GitHubService } from "../github/service";
import {
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  type AttemptKind,
  type AttemptManifest,
  type ManifestUpdatableField,
  type ParentRelationship,
} from "./manifest";
import { validateAttemptRelativePath, assertLeanFileName } from "./paths";
import { attemptReadmeTemplate } from "./template";
import { consumeRateLimit, RATE_LIMITS } from "../ratelimit/limiter";
import { audit } from "../audit/log";
import type { CatalogProblem } from "../problems/catalog";

export interface ServiceContext {
  db: AnyDatabase;
  github: GitHubService;
  progressBranch: string;
  attemptBranchPrefix: string;
  maxOpenAttempts: number;
  maxAttemptsPerDay: number;
  maxSubmissionsPerDay: number;
  maxLeanSubmissionsPerDay: number;
  maxAttemptBytes: number;
  maxFilesPerAttempt: number;
  writesEnabled: boolean;
}

export interface Actor {
  githubUserId: number;
  githubLogin: string;
}

export const MAX_README_BYTES = 128 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_LEAN_TOTAL_BYTES = 512 * 1024;

function assertWritesEnabled(ctx: ServiceContext): void {
  if (!ctx.writesEnabled) {
    throw new InferFundError(
      "FORBIDDEN",
      "This deployment does not allow repository writes (non-production " +
        "environment without INFERFUND_ENABLE_WRITES=true).",
    );
  }
}

async function checkIdempotency(
  ctx: ServiceContext,
  actor: Actor,
  tool: string,
  key: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!key) return null;
  const rows = await ctx.db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.githubUserId, actor.githubUserId),
        eq(idempotencyKeys.tool, tool),
        eq(idempotencyKeys.idempotencyKey, key),
      ),
    )
    .limit(1);
  return rows[0]?.response ?? null;
}

async function storeIdempotency(
  ctx: ServiceContext,
  actor: Actor,
  tool: string,
  key: string | undefined,
  response: Record<string, unknown>,
): Promise<void> {
  if (!key) return;
  await ctx.db
    .insert(idempotencyKeys)
    .values({
      githubUserId: actor.githubUserId,
      tool,
      idempotencyKey: key,
      response,
    })
    .onConflictDoNothing();
}

async function loadOwnedAttempt(
  ctx: ServiceContext,
  actor: Actor,
  attemptId: string,
): Promise<typeof attempts.$inferSelect> {
  const rows = await ctx.db
    .select()
    .from(attempts)
    .where(eq(attempts.attemptId, attemptId))
    .limit(1);
  const attempt = rows[0];
  if (!attempt) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${attemptId} does not exist.`,
    );
  }
  if (attempt.ownerGithubUserId !== actor.githubUserId) {
    throw new InferFundError(
      "ATTEMPT_NOT_OWNED",
      "Only the creator of an attempt may modify it.",
    );
  }
  return attempt;
}

export interface CreateAttemptInput {
  problem: CatalogProblem;
  problemVersionId: string;
  kind: AttemptKind;
  title: string;
  summary?: string;
  parents?: Array<{ attempt_id: string; relationship: ParentRelationship }>;
  idempotencyKey?: string;
}

export interface CreateAttemptResult {
  attempt_id: string;
  branch: string;
  base_progress_sha: string;
  attempt_dir: string;
  status: string;
}

async function ensureProblemMaterialized(
  ctx: ServiceContext,
  problem: CatalogProblem,
  versionId: string,
): Promise<void> {
  await ctx.db
    .insert(problems)
    .values({
      problemKey: problem.problemKey,
      source: problem.source,
      title: problem.title,
      category: problem.category,
      amsTags: problem.amsTags,
      upstreamRepo: problem.upstreamRepo,
      upstreamPath: problem.upstreamPath,
      upstreamModule: problem.upstreamModule,
      upstreamDeclaration: problem.upstreamDeclaration,
      status: problem.openStatus,
      summary: problem.humanStatement?.slice(0, 2000) ?? null,
    })
    .onConflictDoNothing();
  await ctx.db
    .insert(problemVersions)
    .values({
      id: versionId,
      problemKey: problem.problemKey,
      upstreamRef: problem.upstreamRef,
      upstreamCommit: problem.upstreamCommit,
      statementText: problem.statementText,
      statementHash: problem.statementHash,
      humanStatement: problem.humanStatement,
      sourceUrl: problem.sourceUrl,
    })
    .onConflictDoNothing();
}

export async function createAttempt(
  ctx: ServiceContext,
  actor: Actor,
  input: CreateAttemptInput,
): Promise<CreateAttemptResult> {
  const replay = await checkIdempotency(
    ctx,
    actor,
    "create_attempt",
    input.idempotencyKey,
  );
  if (replay) return replay as unknown as CreateAttemptResult;

  assertWritesEnabled(ctx);
  await ensureProblemMaterialized(ctx, input.problem, input.problemVersionId);
  await consumeRateLimit(ctx.db, {
    subject: `u${actor.githubUserId}`,
    rule: RATE_LIMITS.attemptCreatePerDay,
    limitOverride: ctx.maxAttemptsPerDay,
  });

  const openCount = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(attempts)
    .where(
      and(
        eq(attempts.ownerGithubUserId, actor.githubUserId),
        eq(attempts.status, "pending"),
      ),
    );
  if ((openCount[0]?.count ?? 0) >= ctx.maxOpenAttempts) {
    throw new InferFundError(
      "RATE_LIMITED",
      `You already have ${ctx.maxOpenAttempts} open attempts. Submit or close one before creating another.`,
      { retryable: false, details: { limit_type: "open_attempts" } },
    );
  }

  for (const parent of input.parents ?? []) {
    const parentRows = await ctx.db
      .select({ status: attempts.status })
      .from(attempts)
      .where(eq(attempts.attemptId, parent.attempt_id))
      .limit(1);
    if (!parentRows[0]) {
      throw new InferFundError(
        "ATTEMPT_NOT_FOUND",
        `Parent attempt ${parent.attempt_id} does not exist.`,
      );
    }
    if (parentRows[0].status !== "merged") {
      throw new InferFundError(
        "INVALID_INPUT",
        `Parent attempt ${parent.attempt_id} is not merged yet. Only merged attempts can be referenced as parents.`,
      );
    }
  }

  const progressHead = await ctx.github.getBranchHead(ctx.progressBranch);
  if (!progressHead) {
    throw new InferFundError(
      "GITHUB_UNAVAILABLE",
      `The "${ctx.progressBranch}" branch does not exist on the repository.`,
      { retryable: true },
    );
  }

  let attemptId = newAttemptId();
  let branch = attemptBranchName({
    prefix: ctx.attemptBranchPrefix,
    githubUserId: actor.githubUserId,
    problemKey: input.problem.problemKey,
    attemptId,
  });
  for (let tries = 0; tries < 5; tries += 1) {
    if (!(await ctx.github.branchExists(branch))) break;
    attemptId = newAttemptId();
    branch = attemptBranchName({
      prefix: ctx.attemptBranchPrefix,
      githubUserId: actor.githubUserId,
      problemKey: input.problem.problemKey,
      attemptId,
    });
  }
  if (await ctx.github.branchExists(branch)) {
    throw new InferFundError(
      "BRANCH_CONFLICT",
      "Could not allocate a unique attempt branch. Please retry.",
      { retryable: true },
    );
  }

  await ctx.github.createBranch(branch, progressHead.sha);

  const dir = attemptDirectory(input.problem.problemKey, attemptId);
  const now = new Date();
  const manifest: AttemptManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    attempt_id: attemptId,
    problem: {
      source: input.problem.source,
      problem_key: input.problem.problemKey,
      problem_version_id: input.problemVersionId,
      upstream_ref: `${input.problem.upstreamRepo}@${input.problem.upstreamCommit}`,
      statement_hash: input.problem.statementHash,
    },
    author: {
      github_user_id: actor.githubUserId,
      github_login: actor.githubLogin,
    },
    created_at: now.toISOString(),
    base_progress_sha: progressHead.sha,
    kind: input.kind,
    title: input.title,
    summary: input.summary ?? "",
    parents: input.parents ?? [],
    claims: [],
    artifacts: [],
    declared_lean_theorems: [],
    solves_target: false,
    agent_metadata: {},
    research_sources: [],
  };
  const readme = attemptReadmeTemplate({
    title: input.title,
    problemKey: input.problem.problemKey,
    problemTitle: input.problem.title,
  });

  try {
    await ctx.github.upsertFiles(
      branch,
      [
        {
          path: `${dir}/manifest.json`,
          content: JSON.stringify(manifest, null, 2) + "\n",
        },
        { path: `${dir}/README.md`, content: readme },
      ],
      `inferfund: create attempt ${attemptId}`,
    );
  } catch (error) {
    await audit(ctx.db, {
      actorGithubUserId: actor.githubUserId,
      actorKind: "system",
      action: "attempt_creation_compensation_needed",
      targetType: "attempt",
      targetId: attemptId,
      details: { branch },
    });
    throw error;
  }

  const result: CreateAttemptResult = {
    attempt_id: attemptId,
    branch,
    base_progress_sha: progressHead.sha,
    attempt_dir: dir,
    status: "pending",
  };

  try {
    await ctx.db.insert(attempts).values({
      attemptId,
      problemKey: input.problem.problemKey,
      problemVersionId: input.problemVersionId,
      ownerGithubUserId: actor.githubUserId,
      ownerGithubLogin: actor.githubLogin,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? "",
      branchName: branch,
      baseProgressSha: progressHead.sha,
      status: "pending",
    });
    if (input.parents?.length) {
      await ctx.db.insert(attemptEdges).values(
        input.parents.map((p) => ({
          childAttemptId: attemptId,
          parentAttemptId: p.attempt_id,
          relationship: p.relationship,
        })),
      );
    }
    await ctx.db.insert(attemptFiles).values([
      {
        attemptId,
        path: `${dir}/manifest.json`,
        sha256: contentHash(JSON.stringify(manifest, null, 2) + "\n"),
        sizeBytes: Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n"),
      },
      {
        attemptId,
        path: `${dir}/README.md`,
        sha256: contentHash(readme),
        sizeBytes: Buffer.byteLength(readme),
      },
    ]);
  } catch {
    await audit(ctx.db, {
      actorGithubUserId: actor.githubUserId,
      actorKind: "system",
      action: "db_failure_after_branch_creation",
      targetType: "attempt",
      targetId: attemptId,
      details: { branch },
    });
    throw new InferFundError(
      "DATABASE_UNAVAILABLE",
      "Attempt branch was created but recording it failed. Reconciliation will repair this; retry with the same idempotency key.",
      { retryable: true },
    );
  }

  await audit(ctx.db, {
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_created",
    targetType: "attempt",
    targetId: attemptId,
    details: { branch, problem: input.problem.problemKey, kind: input.kind },
  });

  await storeIdempotency(
    ctx,
    actor,
    "create_attempt",
    input.idempotencyKey,
    result as unknown as Record<string, unknown>,
  );
  return result;
}

export interface UpdateAttemptInput {
  attemptId: string;
  readmeBody?: string;
  manifestUpdates?: Partial<
    Pick<AttemptManifest, ManifestUpdatableField>
  >;
  artifacts?: Array<{ path: string; content: string }>;
  leanFiles?: Array<{ name: string; content: string }>;
  idempotencyKey?: string;
}

export async function updateAttempt(
  ctx: ServiceContext,
  actor: Actor,
  input: UpdateAttemptInput,
): Promise<{ attempt_id: string; commit_sha: string; files: string[] }> {
  const replay = await checkIdempotency(
    ctx,
    actor,
    "update_attempt",
    input.idempotencyKey,
  );
  if (replay) {
    return replay as unknown as {
      attempt_id: string;
      commit_sha: string;
      files: string[];
    };
  }
  assertWritesEnabled(ctx);
  const attempt = await loadOwnedAttempt(ctx, actor, input.attemptId);
  if (attempt.status !== "pending") {
    throw new InferFundError(
      "ATTEMPT_ALREADY_SUBMITTED",
      `Attempt is "${attempt.status}" and can no longer be modified.`,
    );
  }
  await consumeRateLimit(ctx.db, {
    subject: `u${actor.githubUserId}`,
    rule: RATE_LIMITS.attemptUpdatePerHour,
  });

  const dir = attemptDirectory(attempt.problemKey, attempt.attemptId);
  const files: Array<{ path: string; content: string }> = [];

  const manifestFile = await ctx.github.readFile(
    attempt.branchName,
    `${dir}/manifest.json`,
  );
  if (!manifestFile) {
    throw new InferFundError(
      "BRANCH_CONFLICT",
      "Attempt manifest is missing on the branch. Reconciliation required.",
      { retryable: true },
    );
  }
  let manifest: AttemptManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestFile.content));
  } catch {
    throw new InferFundError(
      "INVALID_MANIFEST",
      "Existing manifest on branch is invalid. Reconciliation required.",
      { retryable: true },
    );
  }
  if (manifest.author.github_user_id !== actor.githubUserId) {
    throw new InferFundError(
      "ATTEMPT_NOT_OWNED",
      "Manifest author does not match the authenticated user.",
    );
  }

  let totalBytes = 0;
  let leanBytes = 0;

  if (input.readmeBody !== undefined) {
    const bytes = Buffer.byteLength(input.readmeBody);
    if (bytes > MAX_README_BYTES) {
      throw new InferFundError(
        "ARTIFACT_TOO_LARGE",
        `README exceeds ${MAX_README_BYTES} bytes.`,
      );
    }
    totalBytes += bytes;
    files.push({ path: `${dir}/README.md`, content: input.readmeBody });
  }

  for (const artifact of input.artifacts ?? []) {
    const fullPath = `${dir}/artifacts/${artifact.path}`;
    validateAttemptRelativePath(attempt.problemKey, attempt.attemptId, fullPath);
    const bytes = Buffer.byteLength(artifact.content);
    if (bytes > MAX_FILE_BYTES) {
      throw new InferFundError(
        "ARTIFACT_TOO_LARGE",
        `Artifact "${artifact.path}" exceeds ${MAX_FILE_BYTES} bytes.`,
      );
    }
    totalBytes += bytes;
    files.push({ path: fullPath, content: artifact.content });
  }

  const declaredLean: AttemptManifest["declared_lean_theorems"] = [];
  for (const lean of input.leanFiles ?? []) {
    assertLeanFileName(lean.name);
    const fullPath = `${dir}/lean/${lean.name}`;
    validateAttemptRelativePath(attempt.problemKey, attempt.attemptId, fullPath);
    const bytes = Buffer.byteLength(lean.content);
    leanBytes += bytes;
    totalBytes += bytes;
    files.push({ path: fullPath, content: lean.content });
  }
  if (leanBytes > MAX_LEAN_TOTAL_BYTES) {
    throw new InferFundError(
      "ARTIFACT_TOO_LARGE",
      `Lean sources exceed ${MAX_LEAN_TOTAL_BYTES} bytes in total.`,
    );
  }
  if (totalBytes > ctx.maxAttemptBytes) {
    throw new InferFundError(
      "ARTIFACT_TOO_LARGE",
      `Contribution exceeds ${ctx.maxAttemptBytes} bytes in total.`,
    );
  }
  if (files.length > ctx.maxFilesPerAttempt) {
    throw new InferFundError(
      "ARTIFACT_TOO_LARGE",
      `Contribution has more than ${ctx.maxFilesPerAttempt} files.`,
    );
  }

  if (input.manifestUpdates) {
    const allowed: ManifestUpdatableField[] = [
      "title",
      "summary",
      "claims",
      "declared_lean_theorems",
      "agent_metadata",
      "research_sources",
      "solves_target",
    ];
    for (const key of allowed) {
      const value = input.manifestUpdates[key];
      if (value !== undefined) {
        (manifest as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  const artifactList: AttemptManifest["artifacts"] = manifest.artifacts.filter(
    (a) => !(input.artifacts ?? []).some((n) => `artifacts/${n.path}` === a.path),
  );
  for (const artifact of input.artifacts ?? []) {
    artifactList.push({
      path: `artifacts/${artifact.path}`,
      sha256: contentHash(artifact.content),
    });
  }
  manifest.artifacts = artifactList;

  if ((input.leanFiles ?? []).length > 0) {
    manifest.declared_lean_theorems = manifest.declared_lean_theorems.filter(
      (d) => !(input.leanFiles ?? []).some((f) => `lean/${f.name}` === d.file),
    );
    for (const d of manifest.declared_lean_theorems) {
      declaredLean.push(d);
    }
  }

  const manifestContent = JSON.stringify(manifest, null, 2) + "\n";
  files.push({ path: `${dir}/manifest.json`, content: manifestContent });

  const { commitSha } = await ctx.github.upsertFiles(
    attempt.branchName,
    files,
    `inferfund: update attempt ${attempt.attemptId}`,
  );

  await ctx.db
    .update(attempts)
    .set({
      title: manifest.title,
      summary: manifest.summary,
      hasLean:
        (input.leanFiles ?? []).length > 0 ||
        manifest.declared_lean_theorems.length > 0 ||
        attempt.hasLean,
      solvesTarget: manifest.solves_target,
      updatedAt: new Date(),
    })
    .where(eq(attempts.attemptId, attempt.attemptId));

  for (const f of files) {
    await ctx.db
      .insert(attemptFiles)
      .values({
        attemptId: attempt.attemptId,
        path: f.path,
        sha256: contentHash(f.content),
        sizeBytes: Buffer.byteLength(f.content),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [attemptFiles.attemptId, attemptFiles.path],
        set: {
          sha256: contentHash(f.content),
          sizeBytes: Buffer.byteLength(f.content),
          updatedAt: new Date(),
        },
      });
  }

  await audit(ctx.db, {
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_updated",
    targetType: "attempt",
    targetId: attempt.attemptId,
    details: { files: files.map((f) => f.path), commit: commitSha },
  });

  const result = {
    attempt_id: attempt.attemptId,
    commit_sha: commitSha,
    files: files.map((f) => f.path),
  };
  await storeIdempotency(
    ctx,
    actor,
    "update_attempt",
    input.idempotencyKey,
    result as unknown as Record<string, unknown>,
  );
  return result;
}

export interface SubmitAttemptResult {
  attempt_id: string;
  pr_number: number;
  pr_url: string;
  status: string;
}

export async function submitAttempt(
  ctx: ServiceContext,
  actor: Actor,
  input: { attemptId: string; idempotencyKey?: string },
): Promise<SubmitAttemptResult> {
  const replay = await checkIdempotency(
    ctx,
    actor,
    "submit_attempt",
    input.idempotencyKey,
  );
  if (replay) return replay as unknown as SubmitAttemptResult;

  assertWritesEnabled(ctx);
  const attempt = await loadOwnedAttempt(ctx, actor, input.attemptId);
  if (attempt.status === "submitted" || attempt.status === "merged") {
    throw new InferFundError(
      "ATTEMPT_ALREADY_SUBMITTED",
      `Attempt has already been submitted (status: ${attempt.status}).`,
    );
  }
  if (attempt.status !== "pending") {
    throw new InferFundError(
      "ATTEMPT_NOT_EDITABLE",
      `Attempt is "${attempt.status}" and cannot be submitted.`,
    );
  }
  await consumeRateLimit(ctx.db, {
    subject: `u${actor.githubUserId}`,
    rule: RATE_LIMITS.submissionPerDay,
    limitOverride: ctx.maxSubmissionsPerDay,
  });
  if (attempt.hasLean) {
    await consumeRateLimit(ctx.db, {
      subject: `u${actor.githubUserId}`,
      rule: RATE_LIMITS.leanSubmissionPerDay,
      limitOverride: ctx.maxLeanSubmissionsPerDay,
    });
  }

  const dir = attemptDirectory(attempt.problemKey, attempt.attemptId);
  const manifestFile = await ctx.github.readFile(
    attempt.branchName,
    `${dir}/manifest.json`,
  );
  if (!manifestFile) {
    throw new InferFundError(
      "INVALID_MANIFEST",
      "Manifest missing on attempt branch.",
    );
  }
  let manifest: AttemptManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestFile.content));
  } catch (error) {
    throw new InferFundError(
      "INVALID_MANIFEST",
      error instanceof Error ? error.message : "Manifest failed validation.",
    );
  }
  if (manifest.author.github_user_id !== actor.githubUserId) {
    throw new InferFundError(
      "ATTEMPT_NOT_OWNED",
      "Manifest author does not match the authenticated user.",
    );
  }
  if (manifest.base_progress_sha !== attempt.baseProgressSha) {
    throw new InferFundError(
      "INVALID_MANIFEST",
      "Manifest base_progress_sha does not match the recorded base SHA.",
    );
  }
  if (!manifest.summary || manifest.summary.trim().length < 10) {
    throw new InferFundError(
      "INVALID_MANIFEST",
      "A meaningful summary (at least 10 characters) is required before submission.",
    );
  }

  const pr = await ctx.github.createPullRequest({
    head: attempt.branchName,
    base: ctx.progressBranch,
    title: `[${attempt.problemKey}] ${manifest.kind}: ${manifest.title}`,
    body: [
      `InferFund attempt \`${attempt.attemptId}\``,
      "",
      `- Problem: \`${attempt.problemKey}\` (version \`${attempt.problemVersionId}\`)`,
      `- Kind: \`${manifest.kind}\``,
      `- Author: ${manifest.author.github_login} (${manifest.author.github_user_id})`,
      `- Base progress SHA: \`${attempt.baseProgressSha}\``,
      `- Declared Lean theorems: ${manifest.declared_lean_theorems.length}`,
      `- Claims target solved: ${manifest.solves_target ? "yes (requires exact-target verification)" : "no"}`,
      "",
      "This PR was created by InferFund. It may only add files inside its own",
      "attempt directory. Merging is automatic once policy and verification",
      "checks pass.",
    ].join("\n"),
  });

  await ctx.db
    .update(attempts)
    .set({
      status: "submitted",
      prNumber: pr.number,
      prUrl: pr.url,
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(attempts.attemptId, attempt.attemptId));

  try {
    await ctx.github.enableAutoMerge(pr.number);
  } catch {
    await audit(ctx.db, {
      actorGithubUserId: actor.githubUserId,
      actorKind: "system",
      action: "auto_merge_enable_failed",
      targetType: "attempt",
      targetId: attempt.attemptId,
      details: { pr: pr.number },
    });
  }

  await audit(ctx.db, {
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_submitted",
    targetType: "attempt",
    targetId: attempt.attemptId,
    details: { pr: pr.number, pr_url: pr.url },
  });

  const result: SubmitAttemptResult = {
    attempt_id: attempt.attemptId,
    pr_number: pr.number,
    pr_url: pr.url,
    status: "submitted",
  };
  await storeIdempotency(
    ctx,
    actor,
    "submit_attempt",
    input.idempotencyKey,
    result as unknown as Record<string, unknown>,
  );
  return result;
}

export async function recordAttemptMerged(
  ctx: ServiceContext,
  input: {
    attemptId: string;
    mergeCommitSha: string;
  },
): Promise<void> {
  await ctx.db
    .update(attempts)
    .set({
      status: "merged",
      mergedAt: new Date(),
      mergeCommitSha: input.mergeCommitSha,
      updatedAt: new Date(),
    })
    .where(eq(attempts.attemptId, input.attemptId));
  await audit(ctx.db, {
    actorKind: "system",
    action: "attempt_merged",
    targetType: "attempt",
    targetId: input.attemptId,
    details: { merge_commit: input.mergeCommitSha },
  });
}

export async function getLatestProblemVersion(
  ctx: ServiceContext,
  problemKey: string,
): Promise<typeof problemVersions.$inferSelect | null> {
  const rows = await ctx.db
    .select()
    .from(problemVersions)
    .where(eq(problemVersions.problemKey, problemKey))
    .orderBy(problemVersions.createdAt)
    .limit(50);
  return rows.at(-1) ?? null;
}

export async function getActorFromToken(
  ctx: ServiceContext,
  githubUserId: number,
): Promise<Actor> {
  const rows = await ctx.db
    .select()
    .from(users)
    .where(eq(users.githubUserId, githubUserId))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new InferFundError(
      "AUTH_REQUIRED",
      "No InferFund user record for this token. Re-authenticate.",
    );
  }
  if (user.disabled) {
    throw new InferFundError(
      "FORBIDDEN",
      "This account has been disabled by InferFund moderation.",
    );
  }
  return { githubUserId: user.githubUserId, githubLogin: user.githubLogin };
}
