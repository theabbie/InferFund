import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  validateAttestationPullRequest,
  validatePullRequestPolicy,
  type DiffFile,
} from "./policy";

interface CatalogEntry {
  problemKey: string;
  statementHash: string;
}

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

function setOutput(name: string, value: string): void {
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) appendFileSync(outFile, `${name}=${value}\n`);
}

async function main(): Promise<void> {
  const repo = process.env.REPO ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const headBranch = process.env.HEAD_BRANCH ?? "";
  const headSha = process.env.HEAD_SHA ?? "";
  const baseBranch = process.env.BASE_BRANCH ?? "";
  const baseSha = process.env.BASE_SHA ?? "";

  const filesRaw = ghJson<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>
  >([
    "api",
    `repos/${repo}/pulls/${prNumber}/files?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  const files: DiffFile[] = filesRaw.flat().map((f) => ({
    filename: f.filename,
    status: f.status as DiffFile["status"],
    additions: f.additions,
    deletions: f.deletions,
  }));

  const manifestFile = files.find((f) =>
    /attempts\/[a-z0-9-]+\/[0-9a-f-]+\/manifest\.json$/.test(f.filename),
  );
  let manifestContent: string | undefined;
  if (manifestFile) {
    try {
      const res = ghJson<{ content: string }>([
        "api",
        `repos/${repo}/contents/${manifestFile.filename}?ref=${headSha}`,
      ]);
      manifestContent = Buffer.from(res.content, "base64").toString("utf8");
      manifestFile.content = manifestContent;
    } catch {
      manifestContent = undefined;
    }
  }

  const branchMatch =
    /^attempt\/u([0-9]+)\/([a-z0-9][a-z0-9-]*)\/([0-9a-f-]{36})$/.exec(
      headBranch,
    );
  const expectedProblemKey = branchMatch?.[2] ?? "";
  const expectedAttemptId = branchMatch?.[3] ?? "";
  const expectedAuthorId = Number(branchMatch?.[1] ?? "0");
  const isAttestation = headBranch.startsWith("attestation/");

  if (isAttestation) {
    const attResult = validateAttestationPullRequest({
      prBaseBranch: baseBranch,
      headBranch,
      files,
    });
    setOutput("policy_ok", String(attResult.ok));
    setOutput("has_lean", "false");
    setOutput("attempt_dir", "");
    setOutput("attempt_id", expectedAttemptId);
    setOutput("problem_key", expectedProblemKey);
    setOutput("solves_target", "false");
    const conclusion = attResult.ok ? "success" : "failure";
    const summary = attResult.ok
      ? "Attestation PR policy validation passed."
      : `Policy violations:\n${attResult.violations.map((v) => `- ${v}`).join("\n")}`;
    gh([
      "api",
      `repos/${repo}/check-runs`,
      "-f",
      "name=inferfund-policy",
      "-f",
      `head_sha=${headSha}`,
      "-f",
      "status=completed",
      "-f",
      `conclusion=${conclusion}`,
      "-f",
      `output[title]=InferFund policy: ${conclusion}`,
      "-f",
      `output[summary]=${summary.slice(0, 60000)}`,
    ]);
    console.log(attResult.ok ? "POLICY OK (attestation)" : "POLICY FAILED");
    if (!attResult.ok) process.exit(1);
    return;
  }

  const catalog = JSON.parse(
    readFileSync("data/problems.json", "utf8"),
  ) as { problems: CatalogEntry[]; upstreamCommit: string };
  const catalogEntry = catalog.problems.find(
    (p) => p.problemKey === expectedProblemKey,
  );

  let knownParentIds: string[] = [];
  try {
    const tree = ghJson<{ tree: Array<{ path: string }> }>([
      "api",
      `repos/${repo}/git/trees/${baseSha}?recursive=1`,
    ]);
    knownParentIds = tree.tree
      .map((t) => /attempts\/[a-z0-9-]+\/([0-9a-f-]{36})\/manifest\.json$/.exec(t.path)?.[1])
      .filter((x): x is string => Boolean(x));
  } catch {
    knownParentIds = [];
  }

  const config = JSON.parse(
    readFileSync("verifier/config.json", "utf8"),
  ) as { maxLeanFiles: number };

  const result = validatePullRequestPolicy({
    prBaseBranch: baseBranch,
    headBranch,
    headSha,
    files,
    expectedProblemKey,
    expectedAttemptId,
    expectedAuthorGithubUserId: expectedAuthorId,
    expectedBaseProgressSha:
      manifestContent !== undefined
        ? (JSON.parse(manifestContent) as { base_progress_sha?: string })
            .base_progress_sha ?? ""
        : "",
    maxFilesPerAttempt: 20,
    maxAttemptBytes: 1024 * 1024,
    knownParentAttemptIds: knownParentIds,
    validProblemStatementHash: catalogEntry?.statementHash ?? "",
  });

  if (!catalogEntry) {
    result.violations.push(
      `Problem "${expectedProblemKey}" is not in the pinned problem catalog.`,
    );
    result.ok = false;
  }

  const leanFiles = files.filter(
    (f) => f.filename.includes("/lean/") && f.filename.endsWith(".lean"),
  );
  if (leanFiles.length > config.maxLeanFiles) {
    result.violations.push(
      `Too many Lean files: ${leanFiles.length} > ${config.maxLeanFiles}.`,
    );
    result.ok = false;
  }

  setOutput("policy_ok", String(result.ok));
  setOutput("has_lean", String(result.hasLean));
  setOutput("attempt_dir", result.attemptDir ?? "");
  setOutput("attempt_id", expectedAttemptId);
  setOutput("problem_key", expectedProblemKey);
  setOutput("solves_target", String(result.solvesTarget));

  const conclusion = result.ok ? "success" : "failure";
  const summary = result.ok
    ? "Append-only policy validation passed. Structural acceptance only — " +
      "this says nothing about mathematical correctness."
    : `Policy violations:\n${result.violations
        .map((v) => `- ${v}`)
        .join("\n")}`;
  gh([
    "api",
    `repos/${repo}/check-runs`,
    "-f",
    "name=inferfund-policy",
    "-f",
    `head_sha=${headSha}`,
    "-f",
    "status=completed",
    "-f",
    `conclusion=${conclusion}`,
    "-f",
    `output[title]=InferFund policy: ${conclusion}`,
    "-f",
    `output[summary]=${summary.slice(0, 60000)}`,
  ]);

  writeFileSync(
    "policy-result.json",
    JSON.stringify(
      {
        ok: result.ok,
        violations: result.violations,
        attemptDir: result.attemptDir,
        hasLean: result.hasLean,
      },
      null,
      2,
    ),
  );

  console.log(result.ok ? "POLICY OK" : "POLICY FAILED");
  for (const v of result.violations) console.log(` - ${v}`);
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
