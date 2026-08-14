import { createHash } from "node:crypto";
import { InferFundError } from "../errors";
import type {
  CheckRunSummary,
  CollaboratorStatus,
  GitHubFileInput,
  GitHubRefInfo,
  GitHubService,
  PullRequestInfo,
  RepoFileContent,
  TreeEntry,
} from "./service";

interface FakeCommit {
  sha: string;
  files: Map<string, string>;
  parents: string[];
}

interface FakePr extends PullRequestInfo {
  autoMerge: boolean;
}

export class FakeGitHubService implements GitHubService {
  private branches = new Map<string, string>();
  private commits = new Map<string, FakeCommit>();
  private prs = new Map<number, FakePr>();
  private nextPrNumber = 1;
  private collaborators = new Map<string, CollaboratorStatus>();
  private counter = 0;
  issues: Array<{ title: string; body: string; labels: string[] }> = [];
  checkRuns = new Map<string, CheckRunSummary[]>();
  failNextOperation: string | null = null;

  private nextSha(): string {
    this.counter += 1;
    return createHash("sha1")
      .update(`fake-${this.counter}-${Math.random()}`)
      .digest("hex");
  }

  seedBranch(branch: string, files: Record<string, string>): string {
    const sha = this.nextSha();
    this.commits.set(sha, {
      sha,
      files: new Map(Object.entries(files)),
      parents: [],
    });
    this.branches.set(branch, sha);
    return sha;
  }

  private maybeFail(operation: string): void {
    if (this.failNextOperation === operation) {
      this.failNextOperation = null;
      throw new InferFundError(
        "GITHUB_UNAVAILABLE",
        `Simulated GitHub failure during ${operation}.`,
        { retryable: true },
      );
    }
  }

  async getBranchHead(branch: string): Promise<GitHubRefInfo | null> {
    this.maybeFail("getBranchHead");
    const sha = this.branches.get(branch);
    return sha ? { ref: branch, sha } : null;
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.branches.has(branch);
  }

  async createBranch(branch: string, fromSha: string): Promise<GitHubRefInfo> {
    this.maybeFail("createBranch");
    if (this.branches.has(branch)) {
      throw new InferFundError(
        "BRANCH_CONFLICT",
        `Branch "${branch}" already exists.`,
      );
    }
    if (!this.commits.has(fromSha)) {
      throw new InferFundError(
        "BRANCH_CONFLICT",
        `Base SHA "${fromSha}" does not exist.`,
      );
    }
    this.branches.set(branch, fromSha);
    return { ref: branch, sha: fromSha };
  }

  async deleteBranch(branch: string): Promise<void> {
    this.branches.delete(branch);
  }

  async readFile(
    branch: string,
    path: string,
  ): Promise<RepoFileContent | null> {
    const sha = this.branches.get(branch);
    if (!sha) return null;
    const commit = this.commits.get(sha);
    const content = commit?.files.get(path);
    if (content === undefined) return null;
    return { path, content, sha };
  }

  async readFilesAtRef(
    ref: string,
    paths: string[],
  ): Promise<Map<string, string>> {
    const sha = this.branches.get(ref) ?? ref;
    const commit = this.commits.get(sha);
    const result = new Map<string, string>();
    for (const path of paths) {
      const content = commit?.files.get(path);
      if (content !== undefined) result.set(path, content);
    }
    return result;
  }

  async upsertFiles(
    branch: string,
    files: GitHubFileInput[],
  ): Promise<{ commitSha: string }> {
    this.maybeFail("upsertFiles");
    const headSha = this.branches.get(branch);
    if (!headSha) {
      throw new InferFundError(
        "BRANCH_CONFLICT",
        `Branch "${branch}" does not exist.`,
      );
    }
    const head = this.commits.get(headSha);
    const merged = new Map(head?.files ?? []);
    for (const file of files) merged.set(file.path, file.content);
    const sha = this.nextSha();
    this.commits.set(sha, { sha, files: merged, parents: [headSha] });
    this.branches.set(branch, sha);
    return { commitSha: sha };
  }

  async createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestInfo> {
    this.maybeFail("createPullRequest");
    if (!this.branches.has(input.head) || !this.branches.has(input.base)) {
      throw new InferFundError(
        "BRANCH_CONFLICT",
        "Head or base branch does not exist.",
      );
    }
    for (const pr of this.prs.values()) {
      if (pr.state === "open" && pr.headBranch === input.head) {
        throw new InferFundError(
          "BRANCH_CONFLICT",
          `An open PR already exists for branch "${input.head}".`,
        );
      }
    }
    const number = this.nextPrNumber++;
    const pr: FakePr = {
      number,
      url: `https://github.com/fake/repo/pull/${number}`,
      state: "open",
      merged: false,
      headSha: this.branches.get(input.head) ?? "",
      headBranch: input.head,
      baseBranch: input.base,
      createdAt: new Date().toISOString(),
      mergedAt: null,
      autoMerge: false,
    };
    this.prs.set(number, pr);
    return pr;
  }

  async getPullRequest(prNumber: number): Promise<PullRequestInfo | null> {
    return this.prs.get(prNumber) ?? null;
  }

  async listOpenPullRequests(): Promise<PullRequestInfo[]> {
    return [...this.prs.values()].filter((p) => p.state === "open");
  }

  async findMergedPullRequestForBranch(
    branch: string,
  ): Promise<PullRequestInfo | null> {
    return (
      [...this.prs.values()].find(
        (p) => p.headBranch === branch && p.merged,
      ) ?? null
    );
  }

  async enableAutoMerge(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (pr) pr.autoMerge = true;
  }

  async closePullRequest(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (pr) pr.state = "closed";
  }

  async getTreeRecursive(
    branch: string,
  ): Promise<{ sha: string; tree: TreeEntry[] }> {
    const sha = this.branches.get(branch);
    if (!sha) {
      throw new InferFundError(
        "GITHUB_UNAVAILABLE",
        `Branch "${branch}" does not exist.`,
      );
    }
    const commit = this.commits.get(sha);
    const tree: TreeEntry[] = [...(commit?.files.keys() ?? [])].map((p) => ({
      path: p,
      sha: createHash("sha1").update(p).digest("hex"),
      size: commit?.files.get(p)?.length,
    }));
    return { sha, tree };
  }

  async getCheckRunsForRef(sha: string): Promise<CheckRunSummary[]> {
    return this.checkRuns.get(sha) ?? [];
  }

  setCheckRuns(sha: string, runs: CheckRunSummary[]): void {
    this.checkRuns.set(sha, runs);
  }

  async ensureCollaborator(githubLogin: string): Promise<CollaboratorStatus> {
    const existing = this.collaborators.get(githubLogin);
    if (existing && existing.status !== "none") return existing;
    const status: CollaboratorStatus = {
      status: "invited",
      permission: "triage",
      invitationId: 1000 + this.collaborators.size,
    };
    this.collaborators.set(githubLogin, status);
    return status;
  }

  async getCollaboratorStatus(
    githubLogin: string,
  ): Promise<CollaboratorStatus> {
    return this.collaborators.get(githubLogin) ?? { status: "none" };
  }

  async listAttemptBranches(prefix: string): Promise<string[]> {
    return [...this.branches.keys()].filter((b) => b.startsWith(prefix));
  }

  async searchPullRequestsCreatedSince(
    branchPrefix: string,
    sinceIsoDate: string,
  ): Promise<number> {
    const since = new Date(sinceIsoDate).getTime();
    return [...this.prs.values()].filter(
      (p) =>
        p.headBranch.startsWith(branchPrefix) &&
        new Date(p.createdAt).getTime() >= since,
    ).length;
  }

  async createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<string | null> {
    this.issues.push({ title, body, labels });
    return `https://github.com/fake/repo/issues/${this.issues.length}`;
  }

  filesOn(branch: string): Record<string, string> {
    const sha = this.branches.get(branch);
    if (!sha) return {};
    return Object.fromEntries(this.commits.get(sha)?.files ?? []);
  }

  mergePr(prNumber: number): string {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`No PR ${prNumber}`);
    const headFiles = this.filesOn(pr.headBranch);
    const baseFiles = this.filesOn(pr.baseBranch);
    const merged = { ...baseFiles, ...headFiles };
    const sha = this.nextSha();
    this.commits.set(sha, {
      sha,
      files: new Map(Object.entries(merged)),
      parents: [this.branches.get(pr.baseBranch) ?? ""],
    });
    this.branches.set(pr.baseBranch, sha);
    pr.merged = true;
    pr.state = "closed";
    pr.mergedAt = new Date().toISOString();
    return sha;
  }

  openPrs(): FakePr[] {
    return [...this.prs.values()].filter((p) => p.state === "open");
  }
}
