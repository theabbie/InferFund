import { getDb } from "@/lib/db/client";
import { getConfig } from "@/lib/config";
import { consumeUpstreamState } from "@/lib/auth/authorize";
import {
  exchangeGitHubCode,
  fetchGitHubIdentity,
} from "@/lib/auth/github-oauth";
import { createAuthorizationCode } from "@/lib/auth/tokens";
import { upsertUserFromGitHub, ensureCollaboration } from "@/lib/users/service";
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

  const db = getDb();
  const config = getConfig();
  const transaction = await consumeUpstreamState(db, state);
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
  const user = await upsertUserFromGitHub(db, identity);

  await audit(db, {
    actorGithubUserId: user.githubUserId,
    actorKind: "user",
    action: "login",
    targetType: "user",
    targetId: String(user.githubUserId),
    details: { login: user.githubLogin },
  });

  let collaboration: { status: string } = { status: "none" };
  try {
    collaboration = await ensureCollaboration(db, getGitHubService(), {
      githubUserId: user.githubUserId,
      githubLogin: user.githubLogin,
    });
  } catch {
    collaboration = { status: "failed" };
  }

  const inferfundCode = await createAuthorizationCode(
    db,
    config.INFERFUND_TOKEN_SECRET,
    {
      clientId: transaction.clientId,
      githubUserId: user.githubUserId,
      redirectUri: transaction.clientRedirectUri,
      scopes: transaction.scopes,
      resource: transaction.resource,
      codeChallenge: transaction.codeChallenge,
      codeChallengeMethod: transaction.codeChallengeMethod,
    },
  );

  const redirect = new URL(transaction.clientRedirectUri);
  redirect.searchParams.set("code", inferfundCode);
  if (transaction.clientState) {
    redirect.searchParams.set("state", transaction.clientState);
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
      githubLogin: user.githubLogin,
      collaborationStatus: collaboration.status,
    }),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
