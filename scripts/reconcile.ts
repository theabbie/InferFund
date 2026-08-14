import { getConfig } from "../src/lib/config";
import { OctokitGitHubService } from "../src/lib/github/octokit-service";
import { parseAttemptBranchName } from "../src/lib/ids";

async function main(): Promise<void> {
  const config = getConfig();
  const github = new OctokitGitHubService();

  console.log("InferFund reconciliation report (Git-only)");
  console.log("==========================================");

  const progressHead = await github.getBranchHead(
    config.INFERFUND_PROGRESS_BRANCH,
  );
  if (!progressHead) {
    console.log(
      `MISSING: "${config.INFERFUND_PROGRESS_BRANCH}" branch. Run npm run setup:github.`,
    );
    process.exit(2);
  }
  console.log(`progress head: ${progressHead.sha}`);

  let issues = 0;
  const branches = await github.listAttemptBranches(
    `${config.INFERFUND_ATTEMPT_BRANCH_PREFIX}/`,
  );
  const openPrs = await github.listOpenPullRequests();
  const openByBranch = new Map(openPrs.map((p) => [p.headBranch, p]));

  const { tree } = await github.getTreeRecursive(
    config.INFERFUND_PROGRESS_BRANCH,
  );
  const mergedDirs = new Set(
    tree
      .map((t) => /^(attempts\/[a-z0-9-]+\/[0-9a-f-]{36})\//.exec(t.path)?.[1])
      .filter((x): x is string => Boolean(x)),
  );

  for (const branch of branches) {
    const parsed = parseAttemptBranchName(branch);
    if (!parsed) {
      console.log(`MALFORMED_BRANCH ${branch}`);
      issues += 1;
      continue;
    }
    const dir = `attempts/${parsed.problemKey}/${parsed.attemptId}`;
    const openPr = openByBranch.get(branch);
    const merged = mergedDirs.has(dir);
    if (merged && openPr) {
      console.log(
        `PR_OPEN_BUT_MERGED branch=${branch} pr=${openPr.number} (close the PR)`,
      );
      issues += 1;
    }
    if (!merged && !openPr) {
      const manifest = await github.readFile(branch, `${dir}/manifest.json`);
      if (!manifest) {
        console.log(
          `ORPHANED_BRANCH ${branch} (no manifest, no open PR, not merged — safe to delete)`,
        );
        issues += 1;
      }
    }
  }

  for (const pr of openPrs) {
    if (
      !parseAttemptBranchName(pr.headBranch) &&
      !pr.headBranch.startsWith("attestation/")
    ) {
      console.log(
        `NON_STANDARD_PR_OPEN pr=${pr.number} head=${pr.headBranch} base=${pr.baseBranch}`,
      );
      issues += 1;
    }
    if (pr.baseBranch !== config.INFERFUND_PROGRESS_BRANCH) {
      console.log(
        `WRONG_BASE pr=${pr.number} base=${pr.baseBranch} (must be ${config.INFERFUND_PROGRESS_BRANCH})`,
      );
      issues += 1;
    }
  }

  console.log(
    issues === 0
      ? "No inconsistencies found."
      : `${issues} potential issue(s) found. No automatic repairs applied.`,
  );
  process.exit(issues === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error("reconcile failed:", error);
  process.exit(1);
});
