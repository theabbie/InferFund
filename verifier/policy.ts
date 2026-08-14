import { z } from "zod";

export const MANIFEST_SCHEMA_VERSION = 1;

export const manifestPolicySchema = z
  .object({
    schema_version: z.literal(MANIFEST_SCHEMA_VERSION),
    attempt_id: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    problem: z.object({
      source: z.string().min(1),
      problem_key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      problem_version_id: z.string().min(1),
      upstream_ref: z.string().min(1),
      statement_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
    author: z.object({
      github_user_id: z.number().int().positive(),
      github_login: z.string().min(1),
    }),
    created_at: z.string(),
    base_progress_sha: z.string().regex(/^[0-9a-f]{40}$/),
    kind: z.string().min(1),
    title: z.string().min(1).max(200),
    summary: z.string().max(4000),
    parents: z
      .array(
        z.object({
          attempt_id: z.string(),
          relationship: z.string(),
        }),
      )
      .max(32),
    claims: z.array(z.unknown()).max(64),
    artifacts: z.array(z.unknown()).max(64),
    declared_lean_theorems: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.']*$/),
          file: z.string().regex(/^lean\/[A-Za-z0-9_./-]+\.lean$/),
          is_target_proof: z.boolean(),
        }),
      )
      .max(64),
    solves_target: z.boolean(),
    agent_metadata: z.record(z.string(), z.unknown()),
    research_sources: z.array(z.unknown()).max(64),
  })
  .strict();

export type PolicyManifest = z.infer<typeof manifestPolicySchema>;

export interface DiffFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | string;
  additions: number;
  deletions: number;
  sizeBytes?: number;
  content?: string;
}

export interface PolicyInput {
  prBaseBranch: string;
  headBranch: string;
  headSha: string;
  files: DiffFile[];
  expectedProblemKey: string;
  expectedAttemptId: string;
  expectedAuthorGithubUserId: number;
  expectedBaseProgressSha: string;
  maxFilesPerAttempt: number;
  maxAttemptBytes: number;
  knownParentAttemptIds: string[];
  validProblemStatementHash: string;
}

export interface PolicyResult {
  ok: boolean;
  violations: string[];
  attemptDir: string | null;
  hasLean: boolean;
  solvesTarget: boolean;
  manifest: PolicyManifest | null;
  prKind: "attempt" | "attestation";
}

const ATTEMPT_BRANCH_RE =
  /^attempt\/u([0-9]+)\/([a-z0-9][a-z0-9-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

const FORBIDDEN_CONTENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^https?:\/\/[^\s]*$\/lfs\//m, label: "git-lfs pointer" },
  {
    re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    label: "private key material",
  },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, label: "GitHub personal access token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/, label: "GitHub token" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: "API key pattern" },
];

const ATTESTATION_BRANCH_RE =
  /^attestation\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function validateAttestationPullRequest(input: {
  prBaseBranch: string;
  headBranch: string;
  files: DiffFile[];
}): PolicyResult {
  const violations: string[] = [];
  if (input.prBaseBranch !== "progress") {
    violations.push(
      `Attestation PR base branch is "${input.prBaseBranch}", must be "progress".`,
    );
  }
  const match = ATTESTATION_BRANCH_RE.exec(input.headBranch);
  if (!match) {
    violations.push(
      `Attestation branch "${input.headBranch}" must be attestation/<UUIDV7>.`,
    );
  }
  if (input.files.length === 0) {
    violations.push("Attestation PR changes no files.");
  }
  for (const file of input.files) {
    if (file.status !== "added") {
      violations.push(
        `Attestation file "${file.filename}" has status "${file.status}"; only "added" is allowed.`,
      );
      continue;
    }
    if (
      !file.filename.startsWith("attestations/") ||
      !file.filename.endsWith(".json")
    ) {
      violations.push(
        `Attestation PRs may only add attestations/**/*.json; got "${file.filename}".`,
      );
      continue;
    }
    if (file.content !== undefined) {
      try {
        const parsed = JSON.parse(file.content) as { schema_version?: number };
        if (parsed.schema_version !== 1) {
          violations.push(
            `Attestation "${file.filename}" has an unsupported schema_version.`,
          );
        }
      } catch {
        violations.push(`Attestation "${file.filename}" is not valid JSON.`);
      }
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    attemptDir: null,
    hasLean: false,
    solvesTarget: false,
    manifest: null,
    prKind: "attestation",
  };
}

export function isAttestationBranch(branch: string): boolean {
  return ATTESTATION_BRANCH_RE.test(branch);
}

export function validatePullRequestPolicy(input: PolicyInput): PolicyResult {
  if (isAttestationBranch(input.headBranch)) {
    return validateAttestationPullRequest(input);
  }
  const violations: string[] = [];
  const attemptDir = `attempts/${input.expectedProblemKey}/${input.expectedAttemptId}`;

  if (input.prBaseBranch !== "progress") {
    violations.push(
      `PR base branch is "${input.prBaseBranch}", must be exactly "progress".`,
    );
  }

  const branchMatch = ATTEMPT_BRANCH_RE.exec(input.headBranch);
  if (!branchMatch) {
    violations.push(
      `Head branch "${input.headBranch}" does not match ` +
        `attempt/u<GITHUB_ID>/<PROBLEM_KEY>/<UUIDV7>.`,
    );
  } else {
    if (Number(branchMatch[1]) !== input.expectedAuthorGithubUserId) {
      violations.push(
        "Head branch numeric user ID does not match the attempt owner.",
      );
    }
    if (branchMatch[2] !== input.expectedProblemKey) {
      violations.push("Head branch problem key does not match the attempt.");
    }
    if (branchMatch[3] !== input.expectedAttemptId) {
      violations.push("Head branch attempt ID does not match the attempt.");
    }
  }

  if (input.files.length === 0) {
    violations.push("PR changes no files.");
  }
  if (input.files.length > input.maxFilesPerAttempt) {
    violations.push(
      `PR changes ${input.files.length} files; maximum is ${input.maxFilesPerAttempt}.`,
    );
  }

  let totalBytes = 0;
  let hasLean = false;
  for (const file of input.files) {
    if (file.status !== "added") {
      violations.push(
        `File "${file.filename}" has status "${file.status}"; only "added" is allowed (append-only).`,
      );
      continue;
    }
    if (!file.filename.startsWith(`${attemptDir}/`)) {
      violations.push(
        `File "${file.filename}" is outside the attempt directory ${attemptDir}/.`,
      );
      continue;
    }
    const rel = file.filename.slice(attemptDir.length + 1);
    if (
      rel.includes("..") ||
      rel.includes("\u0000") ||
      rel.startsWith("/") ||
      rel.includes("/.git") ||
      rel.split("/").some((s) => s === "" || s === "." || s === "..")
    ) {
      violations.push(`File "${file.filename}" has an unsafe path.`);
      continue;
    }
    const firstSegment = rel.split("/")[0] ?? "";
    const allowed =
      firstSegment === "README.md" ||
      firstSegment === "manifest.json" ||
      firstSegment === "artifacts" ||
      firstSegment === "lean";
    if (!allowed) {
      violations.push(
        `File "${file.filename}" is not README.md, manifest.json, artifacts/ or lean/.`,
      );
      continue;
    }
    if (firstSegment === "lean") {
      if (!rel.endsWith(".lean")) {
        violations.push(`Lean file "${file.filename}" must end with .lean.`);
        continue;
      }
      hasLean = true;
    }
    if (file.sizeBytes !== undefined) {
      totalBytes += file.sizeBytes;
    }
    if (file.content !== undefined) {
      for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
        if (pattern.re.test(file.content)) {
          violations.push(
            `File "${file.filename}" appears to contain ${pattern.label}.`,
          );
        }
      }
    }
  }

  if (totalBytes > input.maxAttemptBytes) {
    violations.push(
      `Total contribution size ${totalBytes} exceeds ${input.maxAttemptBytes} bytes.`,
    );
  }

  let manifest: PolicyManifest | null = null;
  let solvesTarget = false;
  const manifestFile = input.files.find(
    (f) => f.filename === `${attemptDir}/manifest.json`,
  );
  if (!manifestFile) {
    violations.push(`Missing ${attemptDir}/manifest.json.`);
  } else if (manifestFile.content === undefined) {
    violations.push("Manifest content was not provided for validation.");
  } else {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(manifestFile.content);
    } catch {
      violations.push("manifest.json is not valid JSON.");
    }
    if (parsedJson !== undefined) {
      const parsed = manifestPolicySchema.safeParse(parsedJson);
      if (!parsed.success) {
        violations.push(
          "manifest.json failed schema validation: " +
            parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
              .slice(0, 800),
        );
      } else {
        manifest = parsed.data;
        if (manifest.attempt_id !== input.expectedAttemptId) {
          violations.push("Manifest attempt_id does not match the attempt.");
        }
        if (manifest.problem.problem_key !== input.expectedProblemKey) {
          violations.push(
            "Manifest problem key does not match the attempt.",
          );
        }
        if (
          manifest.problem.statement_hash !== input.validProblemStatementHash
        ) {
          violations.push(
            "Manifest statement_hash does not match the current catalog statement hash for the problem version.",
          );
        }
        if (
          manifest.author.github_user_id !== input.expectedAuthorGithubUserId
        ) {
          violations.push(
            "Manifest author github_user_id does not match the attempt owner.",
          );
        }
        if (manifest.base_progress_sha !== input.expectedBaseProgressSha) {
          violations.push(
            "Manifest base_progress_sha does not match the recorded base.",
          );
        }
        for (const parent of manifest.parents) {
          if (!input.knownParentAttemptIds.includes(parent.attempt_id)) {
            violations.push(
              `Parent attempt ${parent.attempt_id} is not a known merged attempt.`,
            );
          }
        }
        for (const decl of manifest.declared_lean_theorems) {
          const leanPath = `${attemptDir}/${decl.file}`;
          if (!input.files.some((f) => f.filename === leanPath)) {
            violations.push(
              `Declared Lean theorem ${decl.name} references missing file ${decl.file}.`,
            );
          }
        }
        solvesTarget = manifest.solves_target;
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    attemptDir,
    hasLean,
    solvesTarget,
    manifest,
    prKind: "attempt",
  };
}
