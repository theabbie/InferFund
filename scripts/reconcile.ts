import { getDb } from "../src/lib/db/client";
import { attempts } from "../src/lib/db/schema";
import { getConfig } from "../src/lib/config";
import { OctokitGitHubService } from "../src/lib/github/octokit-service";

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const github = new OctokitGitHubService();

  console.log("InferFund reconciliation report");
  console.log("================================");

  const allAttempts = await db.select().from(attempts);
  const branches = new Set(await github.listAttemptBranches());
  const progressHead = await github.getBranchHead(
    config.INFERFUND_PROGRESS_BRANCH,
  );
  console.log(
    `progress head: ${progressHead?.sha ?? "MISSING — run scripts/setup-github.ts"}`,
  );

  let issues = 0;
  const dbBranches = new Set(allAttempts.map((a) => a.branchName));

  for (const attempt of allAttempts) {
    if (
      (attempt.status === "pending" || attempt.status === "submitted") &&
      !branches.has(attempt.branchName)
    ) {
      console.log(
        `ORPHANED_DB_RECORD attempt=${attempt.attemptId} branch=${attempt.branchName} ` +
          `(DB says ${attempt.status}, branch missing on GitHub)`,
      );
      issues += 1;
    }
    if (attempt.status === "submitted" && attempt.prNumber !== null) {
      const pr = await github.getPullRequest(attempt.prNumber);
      if (!pr) {
        console.log(
          `MISSING_PR attempt=${attempt.attemptId} pr=${attempt.prNumber}`,
        );
        issues += 1;
      } else if (pr.state === "closed" && !pr.merged) {
        console.log(
          `PR_CLOSED_UNMERGED attempt=${attempt.attemptId} pr=${attempt.prNumber}`,
        );
        issues += 1;
      } else if (pr.merged) {
        console.log(
          `MERGED_NOT_RECORDED attempt=${attempt.attemptId} pr=${attempt.prNumber}`,
        );
        issues += 1;
      }
    }
  }

  for (const branch of branches) {
    if (!dbBranches.has(branch)) {
      console.log(
        `ORPHANED_BRANCH ${branch} (exists on GitHub, no DB record — likely a failed create_attempt)`,
      );
      issues += 1;
    }
  }

  console.log(
    issues === 0
      ? "No inconsistencies found."
      : `${issues} inconsistency/ies found. No automatic repairs were applied; inspect and resolve manually.`,
  );
  process.exit(issues === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error("reconcile failed:", error);
  process.exit(1);
});
