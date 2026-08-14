export interface GitHubFileInput {
  path: string;
  content: string;
}

export interface GitHubRefInfo {
  ref: string;
  sha: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseBranch: string;
}

export interface RepoFileContent {
  path: string;
  content: string;
  sha: string;
}

export interface CollaboratorStatus {
  status: "active" | "invited" | "none";
  permission?: string;
  invitationId?: number;
}

export interface GitHubService {
  getBranchHead(branch: string): Promise<GitHubRefInfo | null>;
  branchExists(branch: string): Promise<boolean>;
  createBranch(branch: string, fromSha: string): Promise<GitHubRefInfo>;
  readFile(branch: string, path: string): Promise<RepoFileContent | null>;
  upsertFiles(
    branch: string,
    files: GitHubFileInput[],
    message: string,
  ): Promise<{ commitSha: string }>;
  createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestInfo>;
  getPullRequest(prNumber: number): Promise<PullRequestInfo | null>;
  enableAutoMerge(prNumber: number): Promise<void>;
  closePullRequest(prNumber: number): Promise<void>;
  ensureCollaborator(
    githubLogin: string,
  ): Promise<CollaboratorStatus>;
  getCollaboratorStatus(githubLogin: string): Promise<CollaboratorStatus>;
  listAttemptBranches(): Promise<string[]>;
}
