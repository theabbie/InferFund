# Deployment

Target platform: Vercel (production). There is no database to provision —
the system is stateless (Git + GitHub metadata + signed tokens).

## One-time external setup (owner actions)

1. **GitHub App** (service identity AND user sign-in — one registration):
   run `npm run setup:github-app` locally. It drives GitHub's App-manifest
   flow, receives the credentials on a localhost callback, captures the
   installation ID, and writes `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`,
   `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`,
   `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_INSTALLATION_ID` to `.env`.
   (Manual alternative: create the App at https://github.com/settings/apps
   with Contents RW, Pull requests RW, Checks RW, Issues RW, Metadata R,
   `pull_request` events, webhook `https://<your-domain>/api/github/webhook`;
   optionally also create a classic OAuth App for the login leg instead of
   using the App's client credentials.)
3. **Rulesets**: `GITHUB_REPO_OWNER=… GITHUB_REPO_NAME=… GITHUB_APP_ID=…
   npm run configure:rulesets` (idempotent).
4. **Admins**: `INFERFUND_ADMIN_GITHUB_IDS=<numeric id>,<…>`.

## Vercel

```bash
vercel link                                # once, local project linkage
# set every variable from .env.example (production scope):
vercel env add INFERFUND_BASE_URL production          # https://<your-domain>
vercel env add INFERFUND_MCP_RESOURCE_URL production  # https://<your-domain>/api/mcp
vercel env add INFERFUND_SESSION_SECRET production
vercel env add INFERFUND_TOKEN_SECRET production
vercel env add GITHUB_OAUTH_CLIENT_ID production
vercel env add GITHUB_OAUTH_CLIENT_SECRET production
vercel env add GITHUB_REPO_OWNER production
vercel env add GITHUB_REPO_NAME production
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_INSTALLATION_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production < key.pem
vercel env add GITHUB_APP_WEBHOOK_SECRET production
vercel env add INFERFUND_ADMIN_GITHUB_IDS production

npm run sync:problems     # refresh catalog if the pin changed
vercel deploy --prod
```

Do **not** set `INFERFUND_ENABLE_WRITES` on the production project (writes are
automatically enabled in production) and **never** set it on previews that
hold production credentials.

## Preview safety

Non-production deployments refuse all GitHub mutations (`FORBIDDEN`) unless
`INFERFUND_ENABLE_WRITES=true` is set explicitly. Only set that variable with
a *sandbox* repository (`GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME` pointing at a
throwaway repo and a sandbox GitHub App).

## Smoke test after deploy

```bash
curl -s https://<your-domain>/api/health | jq
curl -s https://<your-domain>/.well-known/oauth-protected-resource | jq
curl -s https://<your-domain>/.well-known/oauth-authorization-server | jq
curl -s -X POST https://<your-domain>/api/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Then connect with a real MCP client, complete the GitHub authorization, and
run the acceptance flow: search → get_problem → get_frontier → create →
update → submit → CI checks → auto-merge → continue from another account.

## Rollback

`vercel rollback <url>` restores the previous deployment. There is no
database state to roll back; the canonical record is the `progress` branch,
which no deployment can rewrite.
