# InferFund authorization

InferFund separates **MCP protocol authorization** (OAuth 2.1 between the MCP
client and InferFund) from **GitHub identity** (OAuth between InferFund and
GitHub). GitHub access tokens are never accepted as InferFund bearer tokens.

InferFund runs **without a database**. All OAuth artifacts — authorization
codes, upstream states, access tokens, refresh tokens, DCR client
registrations — are HMAC-signed, self-contained, expiring payloads. The
server stores nothing.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/mcp` | MCP resource (Streamable HTTP). Unauthenticated requests get `401` + `WWW-Authenticate: Bearer resource_metadata=…`. |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata: `resource`, `authorization_servers`. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata, incl. `code_challenge_methods_supported: ["S256"]` and `client_id_metadata_document_supported: true`. |
| `GET/POST /oauth/authorize` | Authorization endpoint (consent screen, then GitHub redirect). |
| `POST /oauth/token` | `authorization_code` (PKCE) and `refresh_token` grants. |
| `POST /oauth/register` | RFC 7591 Dynamic Client Registration (for 2025-era clients). |
| `POST /oauth/revoke` | RFC 7009 token revocation. |
| `GET /auth/github/callback` | Upstream GitHub OAuth callback. |

## Flow

1. Client discovers the protected resource metadata from the 401 challenge or
   the well-known URI, then the authorization-server metadata.
2. Client identification, either:
   - **CIMD (current spec)**: the client's `client_id` is an HTTPS URL serving
     its metadata document. InferFund fetches it (bounded: 5s, 16 KiB, no
     redirects), requires `client_id` to equal the URL, and validates
     `redirect_uris` (https, or http on loopback hosts only). Fetched
     documents are cached in memory for 5 minutes.
   - **DCR (legacy)**: `POST /oauth/register` returns a self-describing
     signed `ifd_…` client id (the registration is the id; nothing is
     stored).
3. `GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&resource=<INFERFUND_MCP_RESOURCE_URL>&scope=…`
   renders a consent screen describing the client, scopes and resource.
4. On approval, InferFund redirects to GitHub (`read:user` scope only) with a
   signed, expiring (10 min) upstream state payload.
5. GitHub returns to `/auth/github/callback`. InferFund verifies the state
   signature and expiry, exchanges the code, reads the user's numeric ID +
   login, ensures read-level collaboration (best-effort), and issues a signed
   InferFund authorization code (5 min TTL) bound to client, redirect URI,
   resource and PKCE challenge. Loopback redirect targets get an immediate
   302; remote targets get a success page with a continue link.
6. Client exchanges the code at `/oauth/token` with its `code_verifier`.
   InferFund issues signed access (`ifa_…`, 1h) and refresh (`ifr_…`, 30d)
   tokens carrying {user id, login, client, scopes, resource, iat, exp}.
7. MCP requests carry `Authorization: Bearer ifa_…`. The server verifies the
   signature, expiry, scope, and that `resource` matches
   `INFERFUND_MCP_RESOURCE_URL`, then checks moderation overlays
   (user-disabled and tokens-revoked-before attestations) from `progress`.

## Token security properties

- PKCE S256 mandatory; plain/omitted challenges rejected.
- Tokens are HMAC-signed (never stored), never logged, and never accepted in
  query strings. Access tokens expire in 1h; refresh tokens in 30d.
- Codes and states are PKCE-bound and expiring; because they are stateless,
  single-use is enforced by PKCE binding + short TTL rather than storage
  (replay without the verifier is useless).
- Per-user token revocation: admins file a `tokens_revoked_before`
  attestation; tokens issued before its timestamp are rejected.
  Emergency global revocation: rotate `INFERFUND_TOKEN_SECRET`.
- Open redirects are prevented by exact string match of `redirect_uri`
  against the registered client metadata.
- Admin scope (`inferfund:admin`) is granted only to numeric GitHub IDs
  listed in `INFERFUND_ADMIN_GITHUB_IDS`; clients cannot self-assign it.

## Scope → tool mapping

- Public (no token): `search_problems`, `get_problem`, `list_attempts`,
  `get_attempt`, `get_frontier` — these return public data only.
- `inferfund:contribute`: `create_attempt`, `update_attempt`,
  `submit_attempt`, `continue_attempt`, `review_attempt`, `report_attempt`.
- `inferfund:admin`: `/api/admin` actions (quarantine, disable user, revoke
  tokens).

Unauthenticated calls to protected tools return a structured `AUTH_REQUIRED`
MCP error; insufficient scope returns `FORBIDDEN`; HTTP-level 401/403 follow
RFC 9728 `WWW-Authenticate` conventions (handled by `mcp-handler`'s
`withMcpAuth`).
