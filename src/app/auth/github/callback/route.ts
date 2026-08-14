import { getConfig } from "@/lib/config";
import { consumeUpstreamState } from "@/lib/auth/authorize";
import {
  exchangeGitHubCode,
  fetchGitHubIdentity,
} from "@/lib/auth/github-oauth";
import { createAuthorizationCode } from "@/lib/auth/tokens";
import { ensureCollaboration } from "@/lib/users/service";
import { getGitHubService } from "@/lib/github/octokit-service";
import { audit } from "@/lib/audit/log";
import { SuccessPage, ErrorPage } from "../pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const ghError = url.searchParams.get("error");
  if (ghError) {
    return new Response(
      ErrorPage({
        title: "GitHub authorization was denied",
        detail: `GitHub returned: ${ghError}. You can retry from your MCP client.`,
      }),
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  if (!code || !state) {
    return new Response(
      ErrorPage({
        title: "Invalid callback",
        detail: "Missing code or state parameter.",
      }),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const config = getConfig();
  const transaction = consumeUpstreamState(state);
  if (!transaction) {
    return new Response(
      ErrorPage({
        title: "Authorization session expired",
        detail:
          "The authorization state is invalid, expired, or already used. " +
          "Restart the connection from your MCP client.",
      }),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const ghAccessToken = await exchangeGitHubCode({
    clientId: config.GITHUB_OAUTH_CLIENT_ID ?? "",
    clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    code,
    redirectUri: `${config.INFERFUND_BASE_URL}/auth/github/callback`,
  });
  const identity = await fetchGitHubIdentity({ accessToken: ghAccessToken });

  audit({
    actorGithubUserId: identity.id,
    actorKind: "user",
    action: "login",
    targetType: "user",
    targetId: String(identity.id),
    details: { login: identity.login },
  });

  let collaboration: { status: string } = { status: "none" };
  if (config.writesEnabled) {
    try {
      collaboration = await ensureCollaboration(getGitHubService(), {
        githubUserId: identity.id,
        githubLogin: identity.login,
      });
    } catch {
      collaboration = { status: "failed" };
    }
  }

  const inferfundCode = createAuthorizationCode(config.INFERFUND_TOKEN_SECRET, {
    clientId: transaction.cid ?? "",
    githubUserId: identity.id,
    githubLogin: identity.login,
    redirectUri: transaction.ruri ?? "",
    scopes: transaction.scp ?? [],
    resource: transaction.res ?? "",
    codeChallenge: transaction.cc ?? "",
    codeChallengeMethod: transaction.ccm ?? "S256",
  });

  const redirect = new URL(transaction.ruri ?? "");
  redirect.searchParams.set("code", inferfundCode);
  if (transaction.cstate) {
    redirect.searchParams.set("state", transaction.cstate);
  }

  const isLoopback =
    redirect.hostname === "localhost" ||
    redirect.hostname === "127.0.0.1" ||
    redirect.hostname === "[::1]";

  if (isLoopback) {
    return Response.redirect(redirect.toString(), 302);
  }

  return new Response(
    SuccessPage({
      redirectUrl: redirect.toString(),
      githubLogin: identity.login,
      collaborationStatus: collaboration.status,
    }),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
