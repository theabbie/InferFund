import { OctokitGitHubService } from "../src/lib/github/octokit-service";

async function main(): Promise<void> {
  const login = process.argv[2];
  if (!login) {
    console.error("Usage: npm run invite <github-login>");
    process.exit(1);
  }
  const svc = new OctokitGitHubService();
  const before = await svc.getCollaboratorStatus(login);
  console.log(`current status for ${login}: ${before.status}`);
  if (before.status === "active") {
    console.log("Already a collaborator.");
    return;
  }
  const result = await svc.ensureCollaborator(login);
  console.log(`after ensure: ${JSON.stringify(result)}`);
  if (result.status === "invited") {
    console.log(
      `Invitation sent to ${login}. They must accept it at ` +
        `https://github.com/notifications or the repo page.`,
    );
  } else if (result.status === "none") {
    console.error(
      "Invitation failed. The GitHub App needs Administration: write on " +
        "this repo (edit at https://github.com/settings/apps → your app → " +
        "Permissions → Administration → Read and write, then approve the " +
        "change on the installation).",
    );
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
