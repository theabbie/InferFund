import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getGitHubService } from "@/lib/github/octokit-service";
import { createAttestationPr } from "@/lib/attestations";
import { parseAttemptBranchName } from "@/lib/ids";
import { audit } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifySignature(
  secret: string,
  body: string,
  header: string,
): boolean {
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
    const parsedBranch = parseAttemptBranchName(payload.pull_request.head.ref);
    if (parsedBranch && config.writesEnabled) {
      const github = getGitHubService();
      const checks = await github
        .getCheckRunsForRef(payload.pull_request.head.sha)
        .catch(() => []);
      const verification = checks.find(
        (c) => c.name === "inferfund-verification",
      );
      const policy = checks.find((c) => c.name === "inferfund-policy");
      const leanJob = checks.find((c) => c.name === "lean-execution");
      const leanVerified =
        verification?.conclusion === "success" &&
        leanJob?.conclusion === "success";
      try {
        await createAttestationPr(github, config.INFERFUND_PROGRESS_BRANCH, {
          type: leanVerified ? "lean_verified" : "structurally_valid",
          attempt_id: parsedBranch.attemptId,
          actor_kind: "system",
          verifier: {
            source_sha: payload.pull_request.head.sha,
          },
          payload: {
            policy_check: policy?.conclusion ?? null,
            verification_check: verification?.conclusion ?? null,
            merge_commit: payload.pull_request.merge_commit_sha,
            note: leanVerified
              ? "Lean verification passed for declared theorems."
              : "Merged with structural acceptance (unverified mathematics).",
          },
        });
      } catch (error) {
        audit({
          actorKind: "system",
          action: "attestation_creation_failed",
          targetType: "attempt",
          targetId: parsedBranch.attemptId,
          details: {
            error: error instanceof Error ? error.message : "unknown",
          },
        });
      }
    }
  }

  return new Response("ok", { status: 200 });
}

export async function GET(): Promise<Response> {
  return new Response("InferFund GitHub webhook endpoint", { status: 200 });
}
