# InferFund authorization

InferFund separates **MCP protocol authorization** (OAuth 2.1 between the MCP
client and InferFund) from **GitHub identity** (OAuth between InferFund and
GitHub). GitHub access tokens are never accepted as InferFund bearer tokens.

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
     `redirect_uris` (https, or http on loopback hosts only).
   - **DCR (legacy)**: `POST /oauth/register` issues an `ifd_…` client id.
3. `GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&resource=<INFERFUND_MCP_RESOURCE_URL>&scope=…`
   renders a consent screen describing the client, scopes and resource.
4. On approval, InferFund stores a single-use upstream state (10 min TTL,
   SHA-256 hashed) and redirects to GitHub (`read:user` scope only).
5. GitHub returns to `/auth/github/callback`. InferFund exchanges the code,
   reads the user's numeric ID + login, upserts the user, ensures read-level
   collaboration (best-effort), and issues a single-use InferFund
   authorization code (5 min TTL) bound to client, redirect URI, resource and
   PKCE challenge. Loopback redirect targets get an immediate 302; remote
   targets get a success page with a continue link.
6. Client exchanges the code at `/oauth/token` with its `code_verifier`.
   InferFund issues an opaque access token (`ifu_…`, 1h) and refresh token
   (`ifr_…`, 30d), both stored HMAC-hashed and bound to the resource.
7. MCP requests carry `Authorization: Bearer ifu_…`. The server checks hash,
   expiry, revocation, scope, and that `resource` matches
   `INFERFUND_MCP_RESOURCE_URL`.

## Token security properties

- PKCE S256 mandatory; plain/omitted challenges rejected.
- Refresh-token rotation; replaying a rotated token revokes the successor
  chain (detection via `rotated_to_hash`).
- Tokens are never logged, never accepted in query strings, and are stored
  only as HMAC-SHA256 digests.
- `state` values are random 192-bit, single-use, expiring, and hashed at rest.
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
