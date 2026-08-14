import { InferFundError } from "../errors";
import {
  attemptBranchName,
  attemptDirectory,
  contentHash,
  newAttemptId,
  parseAttemptBranchName,
} from "../ids";
import type { GitHubService, PullRequestInfo } from "../github/service";
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

export interface ReadContext {
  github: GitHubService;
  progressBranch: string;
}

export type AnyContext = ReadContext | ServiceContext;

export const MAX_README_BYTES = 128 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_LEAN_TOTAL_BYTES = 512 * 1024;

export type AttemptStatus =
  | "pending"
  | "submitted"
  | "merged"
  | "closed";

export interface AttemptRecord {
  attemptId: string;
  problemKey: string;
  ownerGithubUserId: number;
  ownerGithubLogin: string;
  kind: string;
  title: string;
  summary: string;
  branchName: string | null;
  baseProgressSha: string;
  status: AttemptStatus;
  hasLean: boolean;
  solvesTarget: boolean;
  parents: Array<{ attempt_id: string; relationship: string }>;
  createdAt: string;
  prNumber: number | null;
  prUrl: string | null;
  mergedAt: string | null;
  manifest: AttemptManifest;
}

function assertWritesEnabled(ctx: ServiceContext): void {
  if (!ctx.writesEnabled) {
    throw new InferFundError(
      "FORBIDDEN",
      "This deployment does not allow repository writes (non-production " +
        "environment without INFERFUND_ENABLE_WRITES=true).",
    );
  }
}

export async function locateAttemptBranch(
  ctx: ServiceContext,
  attemptId: string,
): Promise<string | null> {
  const branches = await ctx.github.listAttemptBranches(
    `${ctx.attemptBranchPrefix}/`,
  );
  const suffix = `/${attemptId}`;
  return branches.find((b) => b.endsWith(suffix)) ?? null;
}

export async function findOpenPrForBranch(
  ctx: ServiceContext,
  branch: string,
): Promise<PullRequestInfo | null> {
  const open = await ctx.github.listOpenPullRequests();
  return open.find((p) => p.headBranch === branch) ?? null;
}

export async function loadAttemptFromBranch(
  ctx: ServiceContext,
  branch: string,
): Promise<AttemptRecord | null> {
  const parsed = parseAttemptBranchName(branch);
  if (!parsed) return null;
  const dir = attemptDirectory(parsed.problemKey, parsed.attemptId);
  const manifestFile = await ctx.github.readFile(branch, `${dir}/manifest.json`);
  if (!manifestFile) return null;
  let manifest: AttemptManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestFile.content));
  } catch {
    return null;
  }
  const openPr = await findOpenPrForBranch(ctx, branch);
  let status: AttemptStatus = "pending";
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let mergedAt: string | null = null;
  if (openPr) {
    status = "submitted";
    prNumber = openPr.number;
    prUrl = openPr.url;
  } else {
    const mergedPr = await ctx.github.findMergedPullRequestForBranch(branch);
    if (mergedPr?.merged) {
      status = "merged";
      prNumber = mergedPr.number;
      prUrl = mergedPr.url;
      mergedAt = mergedPr.mergedAt;
    } else {
      const onProgress = await ctx.github.readFile(
        ctx.progressBranch,
        `${dir}/manifest.json`,
      );
      if (onProgress) status = "merged";
    }
  }
  return {
    attemptId: parsed.attemptId,
    problemKey: parsed.problemKey,
    ownerGithubUserId: manifest.author.github_user_id,
    ownerGithubLogin: manifest.author.github_login,
    kind: manifest.kind,
    title: manifest.title,
    summary: manifest.summary,
    branchName: branch,
    baseProgressSha: manifest.base_progress_sha,
    status,
    hasLean: manifest.declared_lean_theorems.length > 0,
    solvesTarget: manifest.solves_target,
    parents: manifest.parents,
    createdAt: manifest.created_at,
    prNumber,
    prUrl,
    mergedAt,
    manifest,
  };
}

export async function loadMergedAttempt(
  ctx: ServiceContext,
  problemKey: string,
  attemptId: string,
): Promise<AttemptRecord | null> {
  const dir = attemptDirectory(problemKey, attemptId);
  const manifestFile = await ctx.github.readFile(
    ctx.progressBranch,
    `${dir}/manifest.json`,
  );
  if (!manifestFile) return null;
  let manifest: AttemptManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestFile.content));
  } catch {
    return null;
  }
  return {
    attemptId,
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
  };
}

export async function findAttemptById(
  ctx: ServiceContext,
  attemptId: string,
): Promise<AttemptRecord | null> {
  const branch = await locateAttemptBranch(ctx, attemptId);
  if (branch) return loadAttemptFromBranch(ctx, branch);
  const { tree } = await ctx.github.getTreeRecursive(ctx.progressBranch);
  const manifestPath = tree.find(
    (t) =>
      t.path.endsWith(`/${attemptId}/manifest.json`) &&
      t.path.startsWith("attempts/"),
  );
  if (!manifestPath) return null;
  const problemKey = manifestPath.path.split("/")[1] ?? "";
  return loadMergedAttempt(ctx, problemKey, attemptId);
}

async function countOpenAttempts(
  ctx: ServiceContext,
  actor: Actor,
): Promise<number> {
  const branches = await ctx.github.listAttemptBranches(
    `${ctx.attemptBranchPrefix}/u${actor.githubUserId}/`,
  );
  let open = 0;
  for (const branch of branches) {
    const mergedPr = await ctx.github.findMergedPullRequestForBranch(branch);
    if (mergedPr?.merged) continue;
    open += 1;
  }
  return open;
}

async function findByIdempotencyKey(
  ctx: ServiceContext,
  actor: Actor,
  key: string,
): Promise<AttemptRecord | null> {
  const branches = await ctx.github.listAttemptBranches(
    `${ctx.attemptBranchPrefix}/u${actor.githubUserId}/`,
  );
  for (const branch of branches) {
    const record = await loadAttemptFromBranch(ctx, branch);
    if (record?.manifest.client_nonce === key) return record;
  }
  return null;
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
  idempotent_replay?: boolean;
}

export async function createAttempt(
  ctx: ServiceContext,
  actor: Actor,
  input: CreateAttemptInput,
): Promise<CreateAttemptResult> {
  assertWritesEnabled(ctx);

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(
      ctx,
      actor,
      input.idempotencyKey,
    );
    if (existing && existing.branchName) {
      return {
        attempt_id: existing.attemptId,
        branch: existing.branchName,
        base_progress_sha: existing.baseProgressSha,
        attempt_dir: attemptDirectory(existing.problemKey, existing.attemptId),
        status: existing.status,
        idempotent_replay: true,
      };
    }
  }

  consumeRateLimit(`u${actor.githubUserId}`, RATE_LIMITS.attemptCreatePerDay, {
    limitOverride: ctx.maxAttemptsPerDay,
  });

  const openCount = await countOpenAttempts(ctx, actor);
  if (openCount >= ctx.maxOpenAttempts) {
    throw new InferFundError(
      "RATE_LIMITED",
      `You already have ${ctx.maxOpenAttempts} open attempts. Submit or wait for a merge before creating another.`,
      { retryable: false, details: { limit_type: "open_attempts" } },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const createdToday = await ctx.github.searchPullRequestsCreatedSince(
    `${ctx.attemptBranchPrefix}/u${actor.githubUserId}/`,
    today,
  );
  if (createdToday >= ctx.maxAttemptsPerDay) {
    throw new InferFundError(
      "RATE_LIMITED",
      `Daily attempt-creation limit reached (${ctx.maxAttemptsPerDay}).`,
      { retryable: true, details: { limit_type: "attempt_create_daily" } },
    );
  }

  for (const parent of input.parents ?? []) {
    const parentRecord = await findAttemptById(ctx, parent.attempt_id);
    if (!parentRecord) {
      throw new InferFundError(
        "ATTEMPT_NOT_FOUND",
        `Parent attempt ${parent.attempt_id} does not exist.`,
      );
    }
    if (parentRecord.status !== "merged") {
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
    ...(input.idempotencyKey ? { client_nonce: input.idempotencyKey } : {}),
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
    audit({
      actorGithubUserId: actor.githubUserId,
      actorKind: "system",
      action: "attempt_creation_compensation_needed",
      targetType: "attempt",
      targetId: attemptId,
      details: { branch },
    });
    throw error;
  }

  audit({
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_created",
    targetType: "attempt",
    targetId: attemptId,
    details: { branch, problem: input.problem.problemKey, kind: input.kind },
  });

  return {
    attempt_id: attemptId,
    branch,
    base_progress_sha: progressHead.sha,
    attempt_dir: dir,
    status: "pending",
  };
}

export interface UpdateAttemptInput {
  attemptId: string;
  readmeBody?: string;
  manifestUpdates?: Partial<Pick<AttemptManifest, ManifestUpdatableField>>;
  artifacts?: Array<{ path: string; content: string }>;
  leanFiles?: Array<{ name: string; content: string }>;
}

export async function updateAttempt(
  ctx: ServiceContext,
  actor: Actor,
  input: UpdateAttemptInput,
): Promise<{ attempt_id: string; commit_sha: string; files: string[] }> {
  assertWritesEnabled(ctx);
  const branch = await locateAttemptBranch(ctx, input.attemptId);
  if (!branch) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist (or is already merged; merged attempts are immutable).`,
    );
  }
  const record = await loadAttemptFromBranch(ctx, branch);
  if (!record) {
    throw new InferFundError(
      "BRANCH_CONFLICT",
      "Attempt branch is missing a readable manifest.",
    );
  }
  if (record.ownerGithubUserId !== actor.githubUserId) {
    throw new InferFundError(
      "ATTEMPT_NOT_OWNED",
      "Only the creator of an attempt may modify it.",
    );
  }
  const branchOwner = parseAttemptBranchName(branch);
  if (branchOwner?.githubUserId !== actor.githubUserId) {
    throw new InferFundError(
      "ATTEMPT_NOT_OWNED",
      "Branch ownership mismatch.",
    );
  }
  if (record.status !== "pending") {
    throw new InferFundError(
      "ATTEMPT_ALREADY_SUBMITTED",
      `Attempt is "${record.status}" and can no longer be modified.`,
    );
  }
  consumeRateLimit(`u${actor.githubUserId}`, RATE_LIMITS.attemptUpdatePerHour);

  const dir = attemptDirectory(record.problemKey, record.attemptId);
  const manifest = record.manifest;
  const files: Array<{ path: string; content: string }> = [];
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
    validateAttemptRelativePath(record.problemKey, record.attemptId, fullPath);
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

  for (const lean of input.leanFiles ?? []) {
    assertLeanFileName(lean.name);
    const fullPath = `${dir}/lean/${lean.name}`;
    validateAttemptRelativePath(record.problemKey, record.attemptId, fullPath);
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

  const artifactList = manifest.artifacts.filter(
    (a) => !(input.artifacts ?? []).some((n) => `artifacts/${n.path}` === a.path),
  );
  for (const artifact of input.artifacts ?? []) {
    artifactList.push({
      path: `artifacts/${artifact.path}`,
      sha256: contentHash(artifact.content),
    });
  }
  manifest.artifacts = artifactList;

  files.push({
    path: `${dir}/manifest.json`,
    content: JSON.stringify(manifest, null, 2) + "\n",
  });

  const { commitSha } = await ctx.github.upsertFiles(
    branch,
    files,
    `inferfund: update attempt ${record.attemptId}`,
  );

  audit({
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_updated",
    targetType: "attempt",
    targetId: record.attemptId,
    details: { files: files.map((f) => f.path), commit: commitSha },
  });

  return {
    attempt_id: record.attemptId,
    commit_sha: commitSha,
    files: files.map((f) => f.path),
  };
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
  input: { attemptId: string },
): Promise<SubmitAttemptResult> {
  assertWritesEnabled(ctx);
  const branch = await locateAttemptBranch(ctx, input.attemptId);
  if (!branch) {
    throw new InferFundError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${input.attemptId} does not exist.`,
    );
  }
  const record = await loadAttemptFromBranch(ctx, branch);
  if (!record) {
    throw new InferFundError("INVALID_MANIFEST", "Manifest unreadable.");
  }
  if (record.ownerGithubUserId !== actor.githubUserId) {
    throw new InferFundError(
      "ATTEMPT_NOT_OWNED",
      "Only the creator of an attempt may submit it.",
    );
  }
  if (record.status === "submitted" || record.status === "merged") {
    throw new InferFundError(
      "ATTEMPT_ALREADY_SUBMITTED",
      `Attempt has already been submitted (status: ${record.status}).`,
    );
  }
  consumeRateLimit(`u${actor.githubUserId}`, RATE_LIMITS.submissionPerDay, {
    limitOverride: ctx.maxSubmissionsPerDay,
  });
  if (record.hasLean) {
    consumeRateLimit(`u${actor.githubUserId}`, RATE_LIMITS.leanSubmissionPerDay, {
      limitOverride: ctx.maxLeanSubmissionsPerDay,
    });
  }

  const manifest = record.manifest;
  if (manifest.base_progress_sha !== record.baseProgressSha) {
    throw new InferFundError(
      "INVALID_MANIFEST",
      "Manifest base_progress_sha does not match the recorded base.",
    );
  }
  if (!manifest.summary || manifest.summary.trim().length < 10) {
    throw new InferFundError(
      "INVALID_MANIFEST",
      "A meaningful summary (at least 10 characters) is required before submission.",
    );
  }

  const pr = await ctx.github.createPullRequest({
    head: branch,
    base: ctx.progressBranch,
    title: `[${record.problemKey}] ${manifest.kind}: ${manifest.title}`,
    body: [
      `InferFund attempt \`${record.attemptId}\``,
      "",
      `- Problem: \`${record.problemKey}\` (version \`${manifest.problem.problem_version_id}\`)`,
      `- Kind: \`${manifest.kind}\``,
      `- Author: ${manifest.author.github_login} (${manifest.author.github_user_id})`,
      `- Base progress SHA: \`${record.baseProgressSha}\``,
      `- Declared Lean theorems: ${manifest.declared_lean_theorems.length}`,
      `- Claims target solved: ${manifest.solves_target ? "yes (requires exact-target verification)" : "no"}`,
      "",
      "This PR was created by InferFund. It may only add files inside its own",
      "attempt directory. Merging is automatic once policy and verification",
      "checks pass.",
    ].join("\n"),
  });

  try {
    await ctx.github.enableAutoMerge(pr.number);
  } catch {
    audit({
      actorGithubUserId: actor.githubUserId,
      actorKind: "system",
      action: "auto_merge_enable_failed",
      targetType: "attempt",
      targetId: record.attemptId,
      details: { pr: pr.number },
    });
  }

  audit({
    actorGithubUserId: actor.githubUserId,
    actorKind: "user",
    action: "attempt_submitted",
    targetType: "attempt",
    targetId: record.attemptId,
    details: { pr: pr.number, pr_url: pr.url },
  });

  return {
    attempt_id: record.attemptId,
    pr_number: pr.number,
    pr_url: pr.url,
    status: "submitted",
  };
}

export async function getOpenAttemptsForUser(
  ctx: ServiceContext,
  actor: Actor,
): Promise<AttemptRecord[]> {
  const branches = await ctx.github.listAttemptBranches(
    `${ctx.attemptBranchPrefix}/u${actor.githubUserId}/`,
  );
  const records: AttemptRecord[] = [];
  for (const branch of branches) {
    const record = await loadAttemptFromBranch(ctx, branch);
    if (record && record.status !== "merged") records.push(record);
  }
  return records;
}
