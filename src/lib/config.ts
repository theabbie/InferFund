import { z } from "zod";

const urlSchema = z.string().url();

const envSchema = z.object({
  INFERFUND_BASE_URL: urlSchema,
  INFERFUND_MCP_RESOURCE_URL: urlSchema,
  DATABASE_URL: z.string().min(1),
  INFERFUND_SESSION_SECRET: z.string().min(32),
  INFERFUND_TOKEN_SECRET: z.string().min(32),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_REPO_OWNER: z.string().min(1),
  GITHUB_REPO_NAME: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_DEV_ADMIN_TOKEN: z.string().min(1).optional(),
  INFERFUND_ADMIN_GITHUB_IDS: z.string().optional(),
  INFERFUND_PROGRESS_BRANCH: z.string().default("progress"),
  INFERFUND_ATTEMPT_BRANCH_PREFIX: z.string().default("attempt"),
  INFERFUND_MAX_OPEN_ATTEMPTS: z.coerce.number().int().positive().default(3),
  INFERFUND_MAX_ATTEMPTS_PER_DAY: z.coerce.number().int().positive().default(5),
  INFERFUND_MAX_SUBMISSIONS_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  INFERFUND_MAX_LEAN_SUBMISSIONS_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  INFERFUND_MAX_ATTEMPT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  INFERFUND_MAX_FILES_PER_ATTEMPT: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  INFERFUND_ENABLE_WRITES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  FORMAL_CONJECTURES_REF: z.string().optional(),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  writesEnabled: boolean;
  adminGithubIds: ReadonlySet<number>;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `InferFund environment configuration is invalid:\n${issues}\n` +
        `See .env.example for the full list of required variables.`,
    );
  }
  const env = parsed.data;
  const isProduction =
    env.VERCEL_ENV === "production" ||
    (env.VERCEL_ENV === undefined && process.env.NODE_ENV === "production");
  const writesEnabled = isProduction || env.INFERFUND_ENABLE_WRITES;
  const adminGithubIds = new Set<number>(
    (env.INFERFUND_ADMIN_GITHUB_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `INFERFUND_ADMIN_GITHUB_IDS contains a non-numeric ID: "${s}"`,
          );
        }
        return n;
      }),
  );
  cached = { ...env, isProduction, writesEnabled, adminGithubIds };
  return cached;
}

export function resetConfigCacheForTests(): void {
  cached = undefined;
}
