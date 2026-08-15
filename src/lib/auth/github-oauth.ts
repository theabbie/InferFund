import { z } from "zod";
import { InferFundError } from "../errors";

const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  avatar_url: z.string().url().optional(),
  name: z.string().nullable().optional(),
});

export type GitHubIdentity = z.infer<typeof githubUserSchema>;

export function githubAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  if (input.scope) {
    url.searchParams.set("scope", input.scope);
  }
  return url.toString();
}

export async function exchangeGitHubCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    },
  );
  if (!response.ok) {
    throw new InferFundError(
      "GITHUB_UNAVAILABLE",
      "GitHub token exchange failed.",
      { retryable: true },
    );
  }
  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!data.access_token) {
    throw new InferFundError(
      "AUTH_REQUIRED",
      `GitHub authorization failed: ${data.error ?? "no access token"}.`,
    );
  }
  return data.access_token;
}

export async function fetchGitHubIdentity(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubIdentity> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.accessToken}`,
      "user-agent": "inferfund",
    },
  });
  if (!response.ok) {
    throw new InferFundError(
      "GITHUB_UNAVAILABLE",
      "Failed to fetch GitHub identity.",
      { retryable: true },
    );
  }
  const parsed = githubUserSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new InferFundError(
      "GITHUB_UNAVAILABLE",
      "GitHub returned an unexpected identity payload.",
      { retryable: true },
    );
  }
  return parsed.data;
}
