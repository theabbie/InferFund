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
  headBranch: string;
  baseBranch: string;
  createdAt: string;
  mergedAt: string | null;
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

export interface TreeEntry {
  path: string;
  sha: string;
  size?: number;
}

export interface CheckRunSummary {
  name: string;
  conclusion: string | null;
}

export interface GitHubService {
  getBranchHead(branch: string): Promise<GitHubRefInfo | null>;
  branchExists(branch: string): Promise<boolean>;
  createBranch(branch: string, fromSha: string): Promise<GitHubRefInfo>;
  deleteBranch(branch: string): Promise<void>;
  readFile(branch: string, path: string): Promise<RepoFileContent | null>;
  readFilesAtRef(
    ref: string,
    paths: string[],
  ): Promise<Map<string, string>>;
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
  listOpenPullRequests(): Promise<PullRequestInfo[]>;
  findMergedPullRequestForBranch(branch: string): Promise<PullRequestInfo | null>;
  enableAutoMerge(prNumber: number): Promise<void>;
  closePullRequest(prNumber: number): Promise<void>;
  getTreeRecursive(branch: string): Promise<{ sha: string; tree: TreeEntry[] }>;
  getCheckRunsForRef(sha: string): Promise<CheckRunSummary[]>;
  ensureCollaborator(githubLogin: string): Promise<CollaboratorStatus>;
  getCollaboratorStatus(githubLogin: string): Promise<CollaboratorStatus>;
  listAttemptBranches(prefix: string): Promise<string[]>;
  searchPullRequestsCreatedSince(
    branchPrefix: string,
    sinceIsoDate: string,
  ): Promise<number>;
  createIssue(title: string, body: string, labels: string[]): Promise<string | null>;
}
