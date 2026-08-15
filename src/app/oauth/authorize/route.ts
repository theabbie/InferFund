import {
  beginGitHubAuthorization,
  validateAuthorizeRequest,
  type AuthorizeRequestParams,
} from "@/lib/auth/authorize";
import { oauthError } from "@/lib/auth/authenticate";
import { ConsentPage } from "./consent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readParams(url: URL): AuthorizeRequestParams {
  const q = url.searchParams;
  return {
    clientId: q.get("client_id") ?? "",
    redirectUri: q.get("redirect_uri") ?? "",
    responseType: q.get("response_type") ?? "",
    state: q.get("state") ?? undefined,
    scope: q.get("scope") ?? undefined,
    resource: q.get("resource") ?? undefined,
    codeChallenge: q.get("code_challenge") ?? undefined,
    codeChallengeMethod: q.get("code_challenge_method") ?? undefined,
  };
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = readParams(url);
  if (!params.clientId || !params.redirectUri) {
    return oauthError(
      400,
      "invalid_request",
      "client_id and redirect_uri are required.",
    );
  }
  const validated = await validateAuthorizeRequest(params);
  if (!validated.ok) {
    return oauthError(validated.status, validated.error, validated.description);
  }
  if (url.searchParams.get("confirm") !== "true") {
    return new Response(
      ConsentPage({
        clientName: validated.client.clientName ?? params.clientId,
        clientId: params.clientId,
        scopes: validated.scopes,
        resource: validated.resource,
        query: url.search,
      }),
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const { githubUrl } = beginGitHubAuthorization(params, validated);
  return Response.redirect(githubUrl, 302);
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const bodyParams = new URLSearchParams(await req.text());
  for (const [k, v] of bodyParams) url.searchParams.set(k, v);
  url.searchParams.set("confirm", "true");
  return GET(new Request(url.toString(), { method: "GET" }));
}
