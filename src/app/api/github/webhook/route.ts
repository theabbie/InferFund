import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getConfig } from "@/lib/config";
import { attempts } from "@/lib/db/schema";
import { recordAttemptMerged, type ServiceContext } from "@/lib/attempts/service";
import { getGitHubService } from "@/lib/github/octokit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifySignature(secret: string, body: string, header: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    merged: boolean;
    merge_commit_sha: string | null;
    base: { ref: string };
    head: { ref: string; sha: string };
  };
}

export async function POST(req: Request): Promise<Response> {
  const config = getConfig();
  const body = await req.text();
  if (config.GITHUB_APP_WEBHOOK_SECRET) {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    if (!verifySignature(config.GITHUB_APP_WEBHOOK_SECRET, body, signature)) {
      return new Response("invalid signature", { status: 401 });
    }
  } else if (config.isProduction) {
    return new Response("webhook secret not configured", { status: 503 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  if (event !== "pull_request") {
    return new Response("ignored", { status: 202 });
  }

  let payload: PullRequestEvent;
  try {
    payload = JSON.parse(body) as PullRequestEvent;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if (
    payload.action === "closed" &&
    payload.pull_request.merged &&
    payload.pull_request.base.ref === config.INFERFUND_PROGRESS_BRANCH
  ) {
    const db = getDb();
    const headBranch = payload.pull_request.head.ref;
    const rows = await db
      .select()
      .from(attempts)
      .where(eq(attempts.branchName, headBranch))
      .limit(1);
    const attempt = rows[0];
    if (attempt && attempt.status !== "merged") {
      const serviceCtx: ServiceContext = {
        db,
        github: getGitHubService(),
        progressBranch: config.INFERFUND_PROGRESS_BRANCH,
        attemptBranchPrefix: config.INFERFUND_ATTEMPT_BRANCH_PREFIX,
        maxOpenAttempts: config.INFERFUND_MAX_OPEN_ATTEMPTS,
        maxAttemptsPerDay: config.INFERFUND_MAX_ATTEMPTS_PER_DAY,
        maxSubmissionsPerDay: config.INFERFUND_MAX_SUBMISSIONS_PER_DAY,
        maxLeanSubmissionsPerDay:
          config.INFERFUND_MAX_LEAN_SUBMISSIONS_PER_DAY,
        maxAttemptBytes: config.INFERFUND_MAX_ATTEMPT_BYTES,
        maxFilesPerAttempt: config.INFERFUND_MAX_FILES_PER_ATTEMPT,
        writesEnabled: config.writesEnabled,
      };
      await recordAttemptMerged(serviceCtx, {
        attemptId: attempt.attemptId,
        mergeCommitSha: payload.pull_request.merge_commit_sha ?? "",
      });
    }
  }

  return new Response("ok", { status: 200 });
}

export async function GET(): Promise<Response> {
  return new Response("InferFund GitHub webhook endpoint", { status: 200 });
}
