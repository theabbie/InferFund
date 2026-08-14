CREATE TABLE "attempt_edges" (
	"child_attempt_id" text NOT NULL,
	"parent_attempt_id" text NOT NULL,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_edges_child_attempt_id_parent_attempt_id_relationship_pk" PRIMARY KEY("child_attempt_id","parent_attempt_id","relationship")
);
--> statement-breakpoint
CREATE TABLE "attempt_files" (
	"attempt_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_files_attempt_id_path_pk" PRIMARY KEY("attempt_id","path")
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"problem_key" text NOT NULL,
	"problem_version_id" text NOT NULL,
	"owner_github_user_id" bigint NOT NULL,
	"owner_github_login" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"branch_name" text NOT NULL,
	"base_progress_sha" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"relevance_status" text DEFAULT 'unreviewed' NOT NULL,
	"solves_target" boolean DEFAULT false NOT NULL,
	"has_lean" boolean DEFAULT false NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"merged_at" timestamp with time zone,
	"merge_commit_sha" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"attestation_id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_github_user_id" bigint,
	"actor_kind" text NOT NULL,
	"related_attempt_id" text,
	"verifier_version" text,
	"payload" jsonb,
	"git_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_github_user_id" bigint,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_collaborations" (
	"github_user_id" bigint NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"permission" text,
	"invitation_id" bigint,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_collaborations_github_user_id_pk" PRIMARY KEY("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"github_user_id" bigint NOT NULL,
	"tool" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_github_user_id_tool_idempotency_key_pk" PRIMARY KEY("github_user_id","tool","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text,
	"reporter_github_user_id" bigint,
	"admin_github_user_id" bigint,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"client_name" text,
	"client_uri" text,
	"redirect_uris" jsonb NOT NULL,
	"grant_types" jsonb NOT NULL,
	"metadata_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"access_token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_to_hash" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_upstream_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_redirect_uri" text NOT NULL,
	"client_state" text,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"problem_key" text NOT NULL,
	"upstream_ref" text NOT NULL,
	"upstream_commit" text NOT NULL,
	"statement_text" text NOT NULL,
	"statement_hash" text NOT NULL,
	"human_statement" text,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"problem_key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"ams_tags" text[],
	"upstream_repo" text NOT NULL,
	"upstream_path" text NOT NULL,
	"upstream_module" text NOT NULL,
	"upstream_declaration" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"pr_number" integer NOT NULL,
	"attempt_id" text NOT NULL,
	"head_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_branch" text NOT NULL,
	"state" text NOT NULL,
	"auto_merge_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_pr_number_pk" PRIMARY KEY("pr_number")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"github_user_id" bigint PRIMARY KEY NOT NULL,
	"github_login" text NOT NULL,
	"github_avatar_url" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_authenticated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"pr_number" integer,
	"source_sha" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"declarations_checked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lean_version" text,
	"formal_conjectures_ref" text,
	"target_match" boolean,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_edges" ADD CONSTRAINT "attempt_edges_child_attempt_id_attempts_attempt_id_fk" FOREIGN KEY ("child_attempt_id") REFERENCES "public"."attempts"("attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_files" ADD CONSTRAINT "attempt_files_attempt_id_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_problem_key_problems_problem_key_fk" FOREIGN KEY ("problem_key") REFERENCES "public"."problems"("problem_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_problem_version_id_problem_versions_id_fk" FOREIGN KEY ("problem_version_id") REFERENCES "public"."problem_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_owner_github_user_id_users_github_user_id_fk" FOREIGN KEY ("owner_github_user_id") REFERENCES "public"."users"("github_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_attempt_id_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_collaborations" ADD CONSTRAINT "github_collaborations_github_user_id_users_github_user_id_fk" FOREIGN KEY ("github_user_id") REFERENCES "public"."users"("github_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_github_user_id_users_github_user_id_fk" FOREIGN KEY ("github_user_id") REFERENCES "public"."users"("github_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_github_user_id_users_github_user_id_fk" FOREIGN KEY ("github_user_id") REFERENCES "public"."users"("github_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_github_user_id_users_github_user_id_fk" FOREIGN KEY ("github_user_id") REFERENCES "public"."users"("github_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_github_user_id_users_github_user_id_fk" FOREIGN KEY ("github_user_id") REFERENCES "public"."users"("github_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_problem_key_problems_problem_key_fk" FOREIGN KEY ("problem_key") REFERENCES "public"."problems"("problem_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_attempt_id_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_attempt_id_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("attempt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_edges_parent_idx" ON "attempt_edges" USING btree ("parent_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_branch_name_idx" ON "attempts" USING btree ("branch_name");--> statement-breakpoint
CREATE INDEX "attempts_problem_idx" ON "attempts" USING btree ("problem_key");--> statement-breakpoint
CREATE INDEX "attempts_owner_idx" ON "attempts" USING btree ("owner_github_user_id");--> statement-breakpoint
CREATE INDEX "attempts_status_idx" ON "attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "attempts_problem_status_idx" ON "attempts" USING btree ("problem_key","status");--> statement-breakpoint
CREATE INDEX "attestations_attempt_idx" ON "attestations" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_github_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "moderation_events_attempt_idx" ON "moderation_events" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_user_idx" ON "oauth_access_tokens" USING btree ("github_user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_expiry_idx" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_codes_user_idx" ON "oauth_authorization_codes" USING btree ("github_user_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_created_idx" ON "oauth_clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_user_idx" ON "oauth_refresh_tokens" USING btree ("github_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "problem_versions_key_hash_idx" ON "problem_versions" USING btree ("problem_key","statement_hash");--> statement-breakpoint
CREATE INDEX "problem_versions_problem_idx" ON "problem_versions" USING btree ("problem_key");--> statement-breakpoint
CREATE INDEX "problems_source_idx" ON "problems" USING btree ("source");--> statement-breakpoint
CREATE INDEX "problems_status_idx" ON "problems" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_attempt_idx" ON "pull_requests" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "users_github_login_idx" ON "users" USING btree ("github_login");--> statement-breakpoint
CREATE INDEX "verification_runs_attempt_idx" ON "verification_runs" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "verification_runs_pr_idx" ON "verification_runs" USING btree ("pr_number");