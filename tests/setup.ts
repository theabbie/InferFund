import { FakeGitHubService } from "../src/lib/github/fake-service";
import type { ServiceContext } from "../src/lib/attempts/service";

export interface TestHarness {
  github: FakeGitHubService;
  ctx: ServiceContext;
  progressSha: string;
}

export function makeHarness(): TestHarness {
  const github = new FakeGitHubService();
  const progressSha = github.seedBranch("progress", {
    "README.md": "# progress\n",
    "FORMAT.md": "# format\n",
  });
  const ctx: ServiceContext = {
    github,
    progressBranch: "progress",
    attemptBranchPrefix: "attempt",
    maxOpenAttempts: 3,
    maxAttemptsPerDay: 5,
    maxSubmissionsPerDay: 10,
    maxLeanSubmissionsPerDay: 5,
    maxAttemptBytes: 1024 * 1024,
    maxFilesPerAttempt: 20,
    writesEnabled: true,
  };
  return { github, ctx, progressSha };
}

export const ALICE = { githubUserId: 11111111, githubLogin: "alice" };
export const BOB = { githubUserId: 22222222, githubLogin: "bob" };

export const TEST_TOKEN_SECRET = "test-token-secret-test-token-secret-1234";
export const TEST_SESSION_SECRET = "test-session-secret-test-session-1234";

export const SAMPLE_PROBLEM = {
  problemKey: "erdos-1",
  source: "formal-conjectures",
  title: "Erdős Problem 1 (erdos_1)",
  category: "research open",
  amsTags: ["5", "11"],
  upstreamRepo: "google-deepmind/formal-conjectures",
  upstreamPath: "FormalConjectures/ErdosProblems/1.lean",
  upstreamModule: "FormalConjectures.ErdosProblems.1",
  upstreamDeclaration: "erdos_1",
  upstreamRef: "main",
  upstreamCommit: "b33d8678a28118c95d8d4f60b11faaf39ccff1e6",
  statementText:
    "theorem erdos_1 : ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ) (_ : IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N",
  statementHash:
    "sha256:d6ef3e37ab317fda531daf2c54d57f875071b562e20edc271a3e2c21da305166",
  humanStatement: "If A...",
  sourceUrl: "https://www.erdosproblems.com/1",
  openStatus: "open",
};
