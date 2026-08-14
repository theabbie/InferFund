import { getConfig } from "@/lib/config";
import { getGitHubService } from "@/lib/github/octokit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = getConfig();
  let githubStatus: "ok" | "unconfigured" | "unavailable" = "unconfigured";
  if (
    config.GITHUB_APP_ID ||
    (config.GITHUB_DEV_ADMIN_TOKEN && !config.isProduction)
  ) {
    try {
      const head = await getGitHubService().getBranchHead(
        config.INFERFUND_PROGRESS_BRANCH,
      );
      githubStatus = head ? "ok" : "unavailable";
    } catch {
      githubStatus = "unavailable";
    }
  }
  const body = {
    status: "ok",
    github: githubStatus,
    progress_branch: config.INFERFUND_PROGRESS_BRANCH,
    github_app_configured: Boolean(
      config.GITHUB_APP_ID &&
        config.GITHUB_APP_INSTALLATION_ID &&
        config.GITHUB_APP_PRIVATE_KEY,
    ),
    github_oauth_configured: Boolean(
      config.GITHUB_OAUTH_CLIENT_ID && config.GITHUB_OAUTH_CLIENT_SECRET,
    ),
    writes_enabled: config.writesEnabled,
    environment: config.VERCEL_ENV ?? "local",
    time: new Date().toISOString(),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
