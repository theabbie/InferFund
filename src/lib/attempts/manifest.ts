import { z } from "zod";

export const MANIFEST_SCHEMA_VERSION = 1;

export const ATTEMPT_KINDS = [
  "exploration",
  "claim",
  "reduction",
  "lemma",
  "formalization",
  "proof",
  "counterexample",
  "computation",
  "reproduction",
  "review",
  "critique",
  "refutation",
  "generalization",
  "special_case",
] as const;

export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const PARENT_RELATIONSHIPS = [
  "extends",
  "improves",
  "formalizes",
  "reproduces",
  "critiques",
  "refutes",
  "generalizes",
  "specializes",
  "uses",
  "independent",
] as const;

export type ParentRelationship = (typeof PARENT_RELATIONSHIPS)[number];

export const VERIFICATION_STATUSES = [
  "unverified",
  "structurally_valid",
  "lean_verified",
  "reproduced",
  "disputed",
  "refuted",
  "quarantined",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const uuidV7 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a UUIDv7",
  );

const shaPattern = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-char lowercase hex git SHA");

export const manifestSchema = z
  .object({
    schema_version: z.literal(MANIFEST_SCHEMA_VERSION),
    attempt_id: uuidV7,
    problem: z.object({
      source: z.string().min(1).max(64),
      problem_key: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .max(128),
      problem_version_id: z.string().min(1).max(128),
      upstream_ref: z.string().min(1).max(256),
      statement_hash: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<hex>"),
    }),
    author: z.object({
      github_user_id: z.number().int().positive(),
      github_login: z.string().min(1).max(64),
    }),
    created_at: z.string().datetime({ offset: false }),
    base_progress_sha: shaPattern,
    kind: z.enum(ATTEMPT_KINDS),
    title: z.string().min(1).max(200),
    summary: z.string().max(4000).default(""),
    parents: z
      .array(
        z.object({
          attempt_id: uuidV7,
          relationship: z.enum(PARENT_RELATIONSHIPS),
        }),
      )
      .max(32)
      .default([]),
    claims: z
      .array(
        z.object({
          statement: z.string().min(1).max(2000),
          confidence: z
            .enum(["conjectured", "argued", "verified_formally"])
            .default("conjectured"),
        }),
      )
      .max(64)
      .default([]),
    artifacts: z
      .array(
        z.object({
          path: z.string().min(1).max(256),
          sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          description: z.string().max(500).optional(),
        }),
      )
      .max(64)
      .default([]),
    declared_lean_theorems: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z_][A-Za-z0-9_.']*$/, "invalid Lean identifier"),
          file: z
            .string()
            .min(1)
            .max(256)
            .regex(/^lean\/[A-Za-z0-9_./-]+\.lean$/),
          is_target_proof: z.boolean().default(false),
        }),
      )
      .max(64)
      .default([]),
    solves_target: z.boolean().default(false),
    agent_metadata: z
      .object({
        model: z.string().max(128).optional(),
        agent: z.string().max(128).optional(),
        provider: z.string().max(128).optional(),
        tool_version: z.string().max(128).optional(),
        approximate_tokens: z.number().int().nonnegative().optional(),
        compute_seconds: z.number().nonnegative().optional(),
      })
      .partial()
      .default({}),
    research_sources: z
      .array(
        z.object({
          url: z.string().url().max(1024),
          title: z.string().max(256).optional(),
          used_for: z.string().max(256).optional(),
        }),
      )
      .max(64)
      .default([]),
    client_nonce: z.string().min(8).max(128).optional(),
  })
  .strict();

export type AttemptManifest = z.infer<typeof manifestSchema>;

export const MANIFEST_UPDATE_ALLOWLIST = [
  "title",
  "summary",
  "claims",
  "declared_lean_theorems",
  "agent_metadata",
  "research_sources",
  "solves_target",
] as const;

export type ManifestUpdatableField = (typeof MANIFEST_UPDATE_ALLOWLIST)[number];

export function parseManifest(data: unknown): AttemptManifest {
  const result = manifestSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid manifest: ${issues}`);
  }
  return result.data;
}
