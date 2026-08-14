import { createHash } from "node:crypto";
import { InferFundError } from "../errors";
import type {
  CollaboratorStatus,
  GitHubFileInput,
  GitHubRefInfo,
  GitHubService,
  PullRequestInfo,
  RepoFileContent,
} from "./service";

interface FakeCommit {
  sha: string;
  files: Map<string, string>;
  parents: string[];
}

export class FakeGitHubService implements GitHubService {
  private branches = new Map<string, string>();
  private commits = new Map<string, FakeCommit>();
  private prs = new Map<number, PullRequestInfo & { autoMerge: boolean }>();
  private nextPrNumber = 1;
  private collaborators = new Map<string, CollaboratorStatus>();
  private counter = 0;
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
      if (pr.state === "open" && pr.headSha === this.branches.get(input.head)) {
        throw new InferFundError(
          "BRANCH_CONFLICT",
          `An open PR already exists for branch "${input.head}".`,
        );
      }
    }
    const number = this.nextPrNumber++;
    const pr = {
      number,
      url: `https://github.com/fake/repo/pull/${number}`,
      state: "open" as const,
      merged: false,
      headSha: this.branches.get(input.head) ?? "",
      baseBranch: input.base,
      autoMerge: false,
    };
    this.prs.set(number, pr);
    return pr;
  }

  async getPullRequest(prNumber: number): Promise<PullRequestInfo | null> {
    return this.prs.get(prNumber) ?? null;
  }

  async enableAutoMerge(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (pr) pr.autoMerge = true;
  }

  async closePullRequest(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (pr) pr.state = "closed";
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

  async listAttemptBranches(): Promise<string[]> {
    return [...this.branches.keys()].filter((b) => b.startsWith("attempt/"));
  }

  filesOn(branch: string): Record<string, string> {
    const sha = this.branches.get(branch);
    if (!sha) return {};
    return Object.fromEntries(this.commits.get(sha)?.files ?? []);
  }

  mergePr(prNumber: number): string {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`No PR ${prNumber}`);
    const headBranch = [...this.branches.entries()].find(
      ([, sha]) => sha === pr.headSha,
    )?.[0];
    if (headBranch) {
      const headFiles = this.filesOn(headBranch);
      const baseFiles = this.filesOn(pr.baseBranch);
      this.seedBranch(pr.baseBranch, { ...baseFiles, ...headFiles });
    }
    pr.merged = true;
    pr.state = "closed";
    return this.branches.get(pr.baseBranch) ?? "";
  }
}
