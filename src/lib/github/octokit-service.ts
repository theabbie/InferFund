import { App } from "octokit";
import type { Octokit } from "octokit";
import { getConfig } from "../config";
import { InferFundError } from "../errors";
import type {
  CollaboratorStatus,
  GitHubFileInput,
  GitHubRefInfo,
  GitHubService,
  PullRequestInfo,
  RepoFileContent,
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
    throw new InferFundError(
      "GITHUB_UNAVAILABLE",
      "GitHub service identity is not configured. Provide GITHUB_APP_ID, " +
        "GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY.",
      { retryable: false },
    );
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
        return {
          ref: branch,
          sha: (res.data.object as { sha: string }).sha,
        };
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
      return {
        ref: branch,
        sha: (res.data.object as { sha: string }).sha,
      };
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
        const content = Buffer.from(data.content, "base64").toString("utf8");
        return { path, content, sha: data.sha };
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) return null;
        throw error;
      }
    });
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
      return {
        number: res.data.number,
        url: res.data.html_url,
        state: "open",
        merged: false,
        headSha: res.data.head.sha,
        baseBranch: input.base,
      };
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
        return {
          number: res.data.number,
          url: res.data.html_url,
          state: res.data.state === "open" ? "open" : "closed",
          merged: res.data.merged_at !== null,
          headSha: res.data.head.sha,
          baseBranch: res.data.base.ref,
        };
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) return null;
        throw error;
      }
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

  async ensureCollaborator(githubLogin: string): Promise<CollaboratorStatus> {
    const octokit = await this.client();
    return this.wrap("ensureCollaborator", async () => {
      const existing = await this.getCollaboratorStatus(githubLogin);
      if (existing.status !== "none") return existing;
      try {
        const res = await octokit.rest.repos.addCollaborator({
          owner: this.owner,
          repo: this.repo,
          username: githubLogin,
          permission: "triage",
        });
        if (res.status === 201 && res.data && "id" in res.data) {
          return {
            status: "invited",
            permission: "triage",
            invitationId: Number(res.data.id),
          };
        }
        return { status: "active", permission: "triage" };
      } catch (error) {
        if (isOctokitRequestError(error) && error.status === 404) {
          return { status: "none" };
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
          status: "active",
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
              status: "invited",
              permission: invitation.permissions,
              invitationId: invitation.id,
            };
          }
          return { status: "none" };
        }
        throw error;
      }
    });
  }

  async listAttemptBranches(): Promise<string[]> {
    const octokit = await this.client();
    return this.wrap("listAttemptBranches", async () => {
      const config = getConfig();
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
          if (b.name.startsWith(`${config.INFERFUND_ATTEMPT_BRANCH_PREFIX}/`)) {
            branches.push(b.name);
          }
        }
        if (res.data.length < 100) break;
        page += 1;
      }
      return branches;
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
