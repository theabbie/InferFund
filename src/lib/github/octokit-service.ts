import { App } from "octokit";
import type { Octokit } from "octokit";
import { getConfig } from "../config";
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

function isOctokitRequestError(
  error: unknown,
): error is { status: number; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  );
}

export class OctokitGitHubService implements GitHubService {
  private readonly owner: string;
  private readonly repo: string;
  private octokitPromise: Promise<Octokit> | undefined;

  constructor() {
    const config = getConfig();
    this.owner = config.GITHUB_REPO_OWNER;
    this.repo = config.GITHUB_REPO_NAME;
  }

  private async client(): Promise<Octokit> {
    if (!this.octokitPromise) {
      this.octokitPromise = this.createClient();
    }
    return this.octokitPromise;
  }

  private async createClient(): Promise<Octokit> {
    const config = getConfig();
    if (
      config.GITHUB_APP_ID &&
      config.GITHUB_APP_PRIVATE_KEY &&
      config.GITHUB_APP_INSTALLATION_ID
    ) {
      const app = new App({
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
      });
      return (await app.getInstallationOctokit(
        Number(config.GITHUB_APP_INSTALLATION_ID),
      )) as unknown as Octokit;
    }
    if (config.GITHUB_DEV_ADMIN_TOKEN && !config.isProduction) {
      const { Octokit: DevOctokit } = await import("octokit");
      return new DevOctokit({ auth: config.GITHUB_DEV_ADMIN_TOKEN });
    }
    const { Octokit: AnonOctokit } = await import("octokit");
    return new AnonOctokit();
  }

  private async wrap<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isOctokitRequestError(error)) {
        throw new InferFundError(
          "GITHUB_UNAVAILABLE",
          `GitHub ${operation} failed with status ${error.status}.`,
          { retryable: error.status >= 500 || error.status === 429 },
        );
      }
      throw error;
    }
  }

  async getBranchHead(branch: string): Promise<GitHubRefInfo | null> {
    const octokit = await this.client();
    return this.wrap("getBranchHead", async () => {
      try {
        const res = await octokit.rest.git.getRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${branch}`,
        });
        return { ref: branch, sha: (res.data.object as { sha: string }).sha };
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) return null;
        throw error;
      }
    });
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.getBranchHead(branch)) !== null;
  }

  async createBranch(branch: string, fromSha: string): Promise<GitHubRefInfo> {
    const octokit = await this.client();
    return this.wrap("createBranch", async () => {
      const res = await octokit.rest.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      });
      return { ref: branch, sha: (res.data.object as { sha: string }).sha };
    });
  }

  async deleteBranch(branch: string): Promise<void> {
    const octokit = await this.client();
    await this.wrap("deleteBranch", async () => {
      await octokit.rest.git.deleteRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branch}`,
      });
    });
  }

  async readFile(
    branch: string,
    path: string,
  ): Promise<RepoFileContent | null> {
    const octokit = await this.client();
    return this.wrap("readFile", async () => {
      try {
        const res = await octokit.rest.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path,
          ref: branch,
        });
        const data = res.data;
        if (Array.isArray(data) || data.type !== "file") return null;
        return {
          path,
          content: Buffer.from(data.content, "base64").toString("utf8"),
          sha: data.sha,
        };
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) return null;
        throw error;
      }
    });
  }

  async readFilesAtRef(
    ref: string,
    paths: string[],
  ): Promise<Map<string, string>> {
    const octokit = await this.client();
    const result = new Map<string, string>();
    await this.wrap("readFilesAtRef", async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < paths.length; i += 10) {
        chunks.push(paths.slice(i, i + 10));
      }
      for (const chunk of chunks) {
        await Promise.all(
          chunk.map(async (path) => {
            try {
              const res = await octokit.rest.repos.getContent({
                owner: this.owner,
                repo: this.repo,
                path,
                ref,
              });
              const data = res.data;
              if (!Array.isArray(data) && data.type === "file") {
                result.set(
                  path,
                  Buffer.from(data.content, "base64").toString("utf8"),
                );
              }
            } catch (error) {
              if (isOctokitRequestError(error) && error.status === 404) return;
              throw error;
            }
          }),
        );
      }
    });
    return result;
  }

  async upsertFiles(
    branch: string,
    files: GitHubFileInput[],
    message: string,
  ): Promise<{ commitSha: string }> {
    const octokit = await this.client();
    return this.wrap("upsertFiles", async () => {
      const head = await this.getBranchHead(branch);
      if (!head) {
        throw new InferFundError(
          "BRANCH_CONFLICT",
          `Branch "${branch}" does not exist.`,
        );
      }
      const baseCommit = await octokit.rest.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: head.sha,
      });
      const treeEntries = await Promise.all(
        files.map(async (file) => {
          const blob = await octokit.rest.git.createBlob({
            owner: this.owner,
            repo: this.repo,
            content: Buffer.from(file.content, "utf8").toString("base64"),
            encoding: "base64",
          });
          return {
            path: file.path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: blob.data.sha,
          };
        }),
      );
      const tree = await octokit.rest.git.createTree({
        owner: this.owner,
        repo: this.repo,
        base_tree: baseCommit.data.tree.sha,
        tree: treeEntries,
      });
      const commit = await octokit.rest.git.createCommit({
        owner: this.owner,
        repo: this.repo,
        message,
        tree: tree.data.sha,
        parents: [head.sha],
      });
      await octokit.rest.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
        force: false,
      });
      return { commitSha: commit.data.sha };
    });
  }

  private mapPr(data: {
    number: number;
    html_url: string;
    state: string;
    merged_at: string | null;
    head: { sha: string; ref: string };
    base: { ref: string };
    created_at: string;
  }): PullRequestInfo {
    return {
      number: data.number,
      url: data.html_url,
      state: data.state === "open" ? "open" : "closed",
      merged: data.merged_at !== null,
      headSha: data.head.sha,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      createdAt: data.created_at,
      mergedAt: data.merged_at,
    };
  }

  async createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestInfo> {
    const octokit = await this.client();
    return this.wrap("createPullRequest", async () => {
      const res = await octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        maintainer_can_modify: false,
      });
      return this.mapPr(res.data);
    });
  }

  async getPullRequest(prNumber: number): Promise<PullRequestInfo | null> {
    const octokit = await this.client();
    return this.wrap("getPullRequest", async () => {
      try {
        const res = await octokit.rest.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        });
        return this.mapPr(res.data);
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) return null;
        throw error;
      }
    });
  }

  async listOpenPullRequests(): Promise<PullRequestInfo[]> {
    const octokit = await this.client();
    return this.wrap("listOpenPullRequests", async () => {
      const all: PullRequestInfo[] = [];
      let page = 1;
      for (;;) {
        const res = await octokit.rest.pulls.list({
          owner: this.owner,
          repo: this.repo,
          state: "open",
          per_page: 100,
          page,
        });
        all.push(...res.data.map((d) => this.mapPr(d)));
        if (res.data.length < 100) break;
        page += 1;
      }
      return all;
    });
  }

  async findMergedPullRequestForBranch(
    branch: string,
  ): Promise<PullRequestInfo | null> {
    const octokit = await this.client();
    return this.wrap("findMergedPullRequestForBranch", async () => {
      const res = await octokit.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: "closed",
        head: `${this.owner}:${branch}`,
        per_page: 10,
      });
      const merged = res.data.find((d) => d.merged_at !== null);
      return merged ? this.mapPr(merged) : null;
    });
  }

  async enableAutoMerge(prNumber: number): Promise<void> {
    const octokit = await this.client();
    await this.wrap("enableAutoMerge", async () => {
      const pr = await octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });
      await octokit.graphql(
        `mutation ($prId: ID!) {
          enablePullRequestAutoMerge(input: {
            pullRequestId: $prId,
            mergeMethod: SQUASH
          }) { pullRequest { number } }
        }`,
        { prId: pr.data.node_id },
      );
    });
  }

  async closePullRequest(prNumber: number): Promise<void> {
    const octokit = await this.client();
    await this.wrap("closePullRequest", async () => {
      await octokit.rest.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        state: "closed",
      });
    });
  }

  async getTreeRecursive(
    branch: string,
  ): Promise<{ sha: string; tree: TreeEntry[] }> {
    const octokit = await this.client();
    return this.wrap("getTreeRecursive", async () => {
      const head = await this.getBranchHead(branch);
      if (!head) {
        throw new InferFundError(
          "GITHUB_UNAVAILABLE",
          `Branch "${branch}" does not exist.`,
        );
      }
      const res = await octokit.rest.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: head.sha,
        recursive: "true",
      });
      return {
        sha: head.sha,
        tree: res.data.tree
          .filter((t) => t.type === "blob" && t.path)
          .map((t) => ({
            path: t.path as string,
            sha: t.sha as string,
            size: t.size,
          })),
      };
    });
  }

  async getCheckRunsForRef(sha: string): Promise<CheckRunSummary[]> {
    const octokit = await this.client();
    return this.wrap("getCheckRunsForRef", async () => {
      const res = await octokit.rest.checks.listForRef({
        owner: this.owner,
        repo: this.repo,
        ref: sha,
        per_page: 100,
      });
      return res.data.check_runs.map((c) => ({
        name: c.name,
        conclusion: c.conclusion,
      }));
    });
  }

  async ensureCollaborator(githubLogin: string): Promise<CollaboratorStatus> {
    const existing = await this.getCollaboratorStatus(githubLogin);
    if (existing.status !== "none") return existing;
    const octokit = await this.client();
    return this.wrap("ensureCollaborator", async () => {
      try {
        const res = await octokit.rest.repos.addCollaborator({
          owner: this.owner,
          repo: this.repo,
          username: githubLogin,
          permission: "write",
        });
        if (res.status === 201 && res.data && "id" in res.data) {
          return {
            status: "invited" as const,
            permission: "write",
            invitationId: Number(res.data.id),
          };
        }
        return { status: "active" as const, permission: "triage" };
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) {
          return { status: "none" as const };
        }
        throw error;
      }
    });
  }

  async getCollaboratorStatus(
    githubLogin: string,
  ): Promise<CollaboratorStatus> {
    const octokit = await this.client();
    return this.wrap("getCollaboratorStatus", async () => {
      try {
        const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
          owner: this.owner,
          repo: this.repo,
          username: githubLogin,
        });
        return {
          status: "active" as const,
          permission: String(res.data.permission),
        };
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) {
          const invitations = await octokit.rest.repos.listInvitations({
            owner: this.owner,
            repo: this.repo,
            per_page: 100,
          });
          const invitation = invitations.data.find(
            (inv) =>
              inv.invitee?.login?.toLowerCase() === githubLogin.toLowerCase(),
          );
          if (invitation) {
            return {
              status: "invited" as const,
              permission: invitation.permissions,
              invitationId: invitation.id,
            };
          }
          return { status: "none" as const };
        }
        throw error;
      }
    });
  }

  async listAttemptBranches(prefix: string): Promise<string[]> {
    const octokit = await this.client();
    return this.wrap("listAttemptBranches", async () => {
      const branches: string[] = [];
      let page = 1;
      for (;;) {
        const res = await octokit.rest.repos.listBranches({
          owner: this.owner,
          repo: this.repo,
          per_page: 100,
          page,
        });
        for (const b of res.data) {
          if (b.name.startsWith(prefix)) branches.push(b.name);
        }
        if (res.data.length < 100) break;
        page += 1;
      }
      return branches;
    });
  }

  async searchPullRequestsCreatedSince(
    branchPrefix: string,
    sinceIsoDate: string,
  ): Promise<number> {
    const octokit = await this.client();
    return this.wrap("searchPullRequestsCreatedSince", async () => {
      const prs = await octokit.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: "all",
        per_page: 100,
        sort: "created",
        direction: "desc",
      });
      const since = new Date(sinceIsoDate).getTime();
      return prs.data.filter(
        (p) =>
          p.head.ref.startsWith(branchPrefix) &&
          new Date(p.created_at).getTime() >= since,
      ).length;
    });
  }

  async createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<string | null> {
    const octokit = await this.client();
    return this.wrap("createIssue", async () => {
      try {
        const res = await octokit.rest.issues.create({
          owner: this.owner,
          repo: this.repo,
          title,
          body,
          labels,
        });
        return res.data.html_url;
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 410) return null;
        throw error;
      }
    });
  }
}

const globalRegistry = globalThis as unknown as {
  __inferfundGitHub?: GitHubService;
};

export function getGitHubService(): GitHubService {
  if (!globalRegistry.__inferfundGitHub) {
    globalRegistry.__inferfundGitHub = new OctokitGitHubService();
  }
  return globalRegistry.__inferfundGitHub;
}

export function setGitHubServiceForTests(service: GitHubService): void {
  globalRegistry.__inferfundGitHub = service;
}
