import {
  pgTable,
  text,
  bigint,
  boolean,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    githubUserId: bigint("github_user_id", { mode: "number" }).primaryKey(),
    githubLogin: text("github_login").notNull(),
    githubAvatarUrl: text("github_avatar_url"),
    disabled: boolean("disabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAuthenticatedAt: timestamp("last_authenticated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("users_github_login_idx").on(t.githubLogin)],
);

export const githubCollaborations = pgTable(
  "github_collaborations",
  {
    githubUserId: bigint("github_user_id", { mode: "number" })
      .notNull()
      .references(() => users.githubUserId),
    status: text("status", {
      enum: ["none", "invited", "active", "failed", "not_required"],
    })
      .notNull()
      .default("none"),
    permission: text("permission"),
    invitationId: bigint("invitation_id", { mode: "number" }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.githubUserId] })],
);

export const oauthClients = pgTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    kind: text("kind", { enum: ["cimd", "dcr"] }).notNull(),
    clientName: text("client_name"),
    clientUri: text("client_uri"),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    grantTypes: jsonb("grant_types").$type<string[]>().notNull(),
    metadataFetchedAt: timestamp("metadata_fetched_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("oauth_clients_created_idx").on(t.createdAt)],
);

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId),
    githubUserId: bigint("github_user_id", { mode: "number" })
      .notNull()
      .references(() => users.githubUserId),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("oauth_codes_user_idx").on(t.githubUserId)],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId),
    githubUserId: bigint("github_user_id", { mode: "number" })
      .notNull()
      .references(() => users.githubUserId),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("oauth_access_tokens_user_idx").on(t.githubUserId),
    index("oauth_access_tokens_expiry_idx").on(t.expiresAt),
  ],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    accessTokenHash: text("access_token_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId),
    githubUserId: bigint("github_user_id", { mode: "number" })
      .notNull()
      .references(() => users.githubUserId),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    rotatedToHash: text("rotated_to_hash"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("oauth_refresh_tokens_user_idx").on(t.githubUserId)],
);

export const oauthUpstreamStates = pgTable(
  "oauth_upstream_states",
  {
    stateHash: text("state_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    clientRedirectUri: text("client_redirect_uri").notNull(),
    clientState: text("client_state"),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const problems = pgTable(
  "problems",
  {
    problemKey: text("problem_key").primaryKey(),
    source: text("source").notNull(),
    title: text("title").notNull(),
    category: text("category"),
    amsTags: text("ams_tags").array(),
    upstreamRepo: text("upstream_repo").notNull(),
    upstreamPath: text("upstream_path").notNull(),
    upstreamModule: text("upstream_module").notNull(),
    upstreamDeclaration: text("upstream_declaration").notNull(),
    status: text("status").notNull().default("open"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("problems_source_idx").on(t.source),
    index("problems_status_idx").on(t.status),
  ],
);

export const problemVersions = pgTable(
  "problem_versions",
  {
    id: text("id").primaryKey(),
    problemKey: text("problem_key")
      .notNull()
      .references(() => problems.problemKey),
    upstreamRef: text("upstream_ref").notNull(),
    upstreamCommit: text("upstream_commit").notNull(),
    statementText: text("statement_text").notNull(),
    statementHash: text("statement_hash").notNull(),
    humanStatement: text("human_statement"),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("problem_versions_key_hash_idx").on(
      t.problemKey,
      t.statementHash,
    ),
    index("problem_versions_problem_idx").on(t.problemKey),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    attemptId: text("attempt_id").primaryKey(),
    problemKey: text("problem_key")
      .notNull()
      .references(() => problems.problemKey),
    problemVersionId: text("problem_version_id")
      .notNull()
      .references(() => problemVersions.id),
    ownerGithubUserId: bigint("owner_github_user_id", { mode: "number" })
      .notNull()
      .references(() => users.githubUserId),
    ownerGithubLogin: text("owner_github_login").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    branchName: text("branch_name").notNull(),
    baseProgressSha: text("base_progress_sha").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "submitted",
        "merged",
        "closed",
        "merge_failed",
        "orphaned",
      ],
    })
      .notNull()
      .default("pending"),
    verificationStatus: text("verification_status", {
      enum: [
        "unverified",
        "structurally_valid",
        "lean_verified",
        "reproduced",
        "disputed",
        "refuted",
        "quarantined",
      ],
    })
      .notNull()
      .default("unverified"),
    relevanceStatus: text("relevance_status", {
      enum: ["unreviewed", "target_dependency_verified", "solves_target"],
    })
      .notNull()
      .default("unreviewed"),
    solvesTarget: boolean("solves_target").notNull().default(false),
    hasLean: boolean("has_lean").notNull().default(false),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergeCommitSha: text("merge_commit_sha"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("attempts_branch_name_idx").on(t.branchName),
    index("attempts_problem_idx").on(t.problemKey),
    index("attempts_owner_idx").on(t.ownerGithubUserId),
    index("attempts_status_idx").on(t.status),
    index("attempts_problem_status_idx").on(t.problemKey, t.status),
  ],
);

export const attemptEdges = pgTable(
  "attempt_edges",
  {
    childAttemptId: text("child_attempt_id")
      .notNull()
      .references(() => attempts.attemptId),
    parentAttemptId: text("parent_attempt_id").notNull(),
    relationship: text("relationship").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.childAttemptId, t.parentAttemptId, t.relationship] }),
    index("attempt_edges_parent_idx").on(t.parentAttemptId),
  ],
);

export const attemptFiles = pgTable(
  "attempt_files",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.attemptId),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.attemptId, t.path] })],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    prNumber: integer("pr_number").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.attemptId),
    headBranch: text("head_branch").notNull(),
    headSha: text("head_sha").notNull(),
    baseBranch: text("base_branch").notNull(),
    state: text("state", { enum: ["open", "merged", "closed"] }).notNull(),
    autoMergeEnabled: boolean("auto_merge_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.prNumber] }),
    uniqueIndex("pull_requests_attempt_idx").on(t.attemptId),
  ],
);

export const verificationRuns = pgTable(
  "verification_runs",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.attemptId),
    prNumber: integer("pr_number"),
    sourceSha: text("source_sha").notNull(),
    status: text("status", {
      enum: ["pending", "verified", "failed", "not_applicable"],
    })
      .notNull()
      .default("pending"),
    declarationsChecked: jsonb("declarations_checked")
      .$type<
        Array<{
          name: string;
          type?: string;
          axioms?: string[];
          status: string;
        }>
      >()
      .notNull()
      .default([]),
    leanVersion: text("lean_version"),
    formalConjecturesRef: text("formal_conjectures_ref"),
    targetMatch: boolean("target_match"),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("verification_runs_attempt_idx").on(t.attemptId),
    index("verification_runs_pr_idx").on(t.prNumber),
  ],
);

export const attestations = pgTable(
  "attestations",
  {
    attestationId: text("attestation_id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.attemptId),
    type: text("type", {
      enum: [
        "lean_verified",
        "reproduced",
        "refuted",
        "disputed",
        "quarantined",
        "unquarantined",
        "used_by_verified_proof",
      ],
    }).notNull(),
    actorGithubUserId: bigint("actor_github_user_id", { mode: "number" }),
    actorKind: text("actor_kind", {
      enum: ["verifier", "user", "admin", "system"],
    }).notNull(),
    relatedAttemptId: text("related_attempt_id"),
    verifierVersion: text("verifier_version"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    gitPath: text("git_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("attestations_attempt_idx").on(t.attemptId)],
);

export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id"),
    reporterGithubUserId: bigint("reporter_github_user_id", {
      mode: "number",
    }),
    adminGithubUserId: bigint("admin_github_user_id", { mode: "number" }),
    action: text("action", {
      enum: [
        "report",
        "quarantine",
        "unquarantine",
        "disable_user",
        "enable_user",
        "close_pr",
      ],
    }).notNull(),
    reason: text("reason").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("moderation_events_attempt_idx").on(t.attemptId)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorGithubUserId: bigint("actor_github_user_id", { mode: "number" }),
    actorKind: text("actor_kind", {
      enum: ["user", "admin", "service", "system", "anonymous"],
    }).notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_events_actor_idx").on(t.actorGithubUserId),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    bucketKey: text("bucket_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucketKey, t.windowStart] })],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    githubUserId: bigint("github_user_id", { mode: "number" })
      .notNull()
      .references(() => users.githubUserId),
    tool: text("tool").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.githubUserId, t.tool, t.idempotencyKey] }),
  ],
);
