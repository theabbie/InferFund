import { z } from "zod";
import { newAttemptId } from "./ids";
import type { GitHubService } from "./github/service";
import { audit } from "./audit/log";

export const ATTESTATION_TYPES = [
  "structurally_valid",
  "lean_verified",
  "reproduced",
  "refuted",
  "disputed",
  "quarantined",
  "unquarantined",
  "used_by_verified_proof",
  "user_disabled",
  "user_enabled",
  "tokens_revoked_before",
] as const;

export type AttestationType = (typeof ATTESTATION_TYPES)[number];

export const attestationSchema = z
  .object({
    schema_version: z.literal(1),
    attestation_id: z.string(),
    type: z.enum(ATTESTATION_TYPES),
    attempt_id: z.string().optional(),
    subject_github_user_id: z.number().int().positive().optional(),
    actor_kind: z.enum(["verifier", "user", "admin", "system"]),
    actor_github_user_id: z.number().int().positive().optional(),
    related_attempt_id: z.string().optional(),
    verifier: z
      .object({
        lean_version: z.string().optional(),
        formal_conjectures_ref: z.string().optional(),
        source_sha: z.string().optional(),
        declarations: z.array(z.string()).optional(),
        axioms: z.array(z.string()).optional(),
        target_match: z.boolean().nullable().optional(),
      })
      .optional(),
    reason: z.string().max(2000).optional(),
    revoked_before: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    created_at: z.string(),
  })
  .strict();

export type Attestation = z.infer<typeof attestationSchema>;

export function attestationBranchName(attestationId: string): string {
  return `attestation/${attestationId}`;
}

export function attestationPath(input: {
  attemptId?: string;
  subjectGithubUserId?: number;
  attestationId: string;
}): string {
  if (input.subjectGithubUserId !== undefined) {
    return `attestations/users/${input.subjectGithubUserId}/${input.attestationId}.json`;
  }
  return `attestations/${input.attemptId}/${input.attestationId}.json`;
}

export async function createAttestationPr(
  github: GitHubService,
  progressBranch: string,
  input: Omit<Attestation, "schema_version" | "attestation_id" | "created_at">,
): Promise<{ attestation_id: string; pr_url: string }> {
  const attestationId = newAttemptId();
  const attestation: Attestation = {
    schema_version: 1,
    attestation_id: attestationId,
    created_at: new Date().toISOString(),
    ...input,
  };
  const head = await github.getBranchHead(progressBranch);
  if (!head) {
    throw new Error(`Branch "${progressBranch}" does not exist.`);
  }
  const branch = attestationBranchName(attestationId);
  await github.createBranch(branch, head.sha);
  const path = attestationPath({
    attemptId: input.attempt_id,
    subjectGithubUserId: input.subject_github_user_id,
    attestationId,
  });
  await github.upsertFiles(
    branch,
    [{ path, content: JSON.stringify(attestation, null, 2) + "\n" }],
    `inferfund: attestation ${attestation.type}`,
  );
  const pr = await github.createPullRequest({
    head: branch,
    base: progressBranch,
    title: `attest: ${attestation.type}${attestation.attempt_id ? ` for ${attestation.attempt_id.slice(0, 8)}` : ""}`,
    body: [
      `InferFund attestation \`${attestationId}\``,
      "",
      `- Type: \`${attestation.type}\``,
      `- Attempt: ${attestation.attempt_id ?? "n/a"}`,
      `- Actor kind: \`${attestation.actor_kind}\``,
      "",
      "Append-only attestation record. See docs/progress-format.md.",
    ].join("\n"),
  });
  try {
    await github.enableAutoMerge(pr.number);
  } catch {
    audit({
      actorKind: "system",
      action: "attestation_auto_merge_failed",
      targetType: "attestation",
      targetId: attestationId,
      details: { pr: pr.number },
    });
  }
  audit({
    actorKind: input.actor_kind,
    actorGithubUserId: input.actor_github_user_id,
    action: `attestation_created:${attestation.type}`,
    targetType: "attestation",
    targetId: attestationId,
    details: { attempt: input.attempt_id, pr: pr.number },
  });
  return { attestation_id: attestationId, pr_url: pr.url };
}

interface AttestationCacheEntry {
  treeSha: string;
  attestations: Attestation[];
  fetchedAt: number;
}

let attestationCache: AttestationCacheEntry | null = null;
const ATTESTATION_CACHE_TTL_MS = 60 * 1000;

export async function readAllAttestations(
  github: GitHubService,
  progressBranch: string,
): Promise<Attestation[]> {
  const { sha, tree } = await github.getTreeRecursive(progressBranch);
  if (
    attestationCache &&
    attestationCache.treeSha === sha &&
    Date.now() - attestationCache.fetchedAt < ATTESTATION_CACHE_TTL_MS
  ) {
    return attestationCache.attestations;
  }
  const paths = tree
    .map((t) => t.path)
    .filter(
      (p) => p.startsWith("attestations/") && p.endsWith(".json"),
    );
  const files = await github.readFilesAtRef(sha, paths);
  const attestations: Attestation[] = [];
  for (const content of files.values()) {
    try {
      const parsed = attestationSchema.safeParse(JSON.parse(content));
      if (parsed.success) attestations.push(parsed.data);
    } catch {
      continue;
    }
  }
  attestationCache = { treeSha: sha, attestations, fetchedAt: Date.now() };
  return attestations;
}

export function clearAttestationCacheForTests(): void {
  attestationCache = null;
}

export interface AttemptVerificationView {
  verificationStatus:
    | "unverified"
    | "structurally_valid"
    | "lean_verified"
    | "reproduced"
    | "disputed"
    | "refuted"
    | "quarantined";
  quarantined: boolean;
}

export function deriveVerificationView(
  attemptId: string,
  attestations: Attestation[],
  edges: Array<{ parent: string; relationship: string }>,
): AttemptVerificationView {
  const mine = attestations.filter((a) => a.attempt_id === attemptId);
  let quarantined = false;
  let leanVerified = false;
  for (const a of mine) {
    if (a.type === "quarantined") quarantined = true;
    if (a.type === "unquarantined") quarantined = false;
    if (a.type === "lean_verified") leanVerified = true;
  }
  let reproduced = false;
  let refuted = false;
  let disputed = false;
  for (const edge of edges) {
    if (edge.parent !== attemptId) continue;
    if (edge.relationship === "reproduces") reproduced = true;
    if (edge.relationship === "refutes") refuted = true;
    if (edge.relationship === "critiques") disputed = true;
  }
  const verificationStatus: AttemptVerificationView["verificationStatus"] =
    quarantined
      ? "quarantined"
      : refuted
        ? "refuted"
        : disputed
          ? "disputed"
          : leanVerified && reproduced
            ? "reproduced"
            : leanVerified
              ? "lean_verified"
              : reproduced
                ? "reproduced"
                : "structurally_valid";
  return { verificationStatus, quarantined };
}

export async function isUserDisabled(
  github: GitHubService,
  progressBranch: string,
  githubUserId: number,
): Promise<boolean> {
  const attestations = await readAllAttestations(github, progressBranch);
  const mine = attestations
    .filter((a) => a.subject_github_user_id === githubUserId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  let disabled = false;
  for (const a of mine) {
    if (a.type === "user_disabled") disabled = true;
    if (a.type === "user_enabled") disabled = false;
  }
  return disabled;
}

export async function tokensRevokedBefore(
  github: GitHubService,
  progressBranch: string,
  githubUserId: number,
): Promise<number | null> {
  const attestations = await readAllAttestations(github, progressBranch);
  const revocations = attestations.filter(
    (a) =>
      a.subject_github_user_id === githubUserId &&
      a.type === "tokens_revoked_before" &&
      a.revoked_before,
  );
  if (revocations.length === 0) return null;
  const latest = revocations
    .map((a) => new Date(a.revoked_before!).getTime())
    .reduce((a, b) => Math.max(a, b));
  return latest;
}
