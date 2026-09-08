# UAT v3: OAuth 2.1

## Version Scope

v3 builds on all v1 and v2 test cases. This version adds full OAuth 2.1 support as the standard MCP authorization mechanism, including authorization server metadata discovery, dynamic client registration, the authorization code flow with PKCE, token exchange, token refresh, scoped permissions, and backward compatibility with existing `kh_` Bearer API keys.

**Prerequisites**: All v1 test cases (TC-01 through TC-54) and v2 test cases (TC-55 through TC-95) pass before running v3 tests.

---

## 1. OAuth Discovery

- [ ] **TC-96: Well-known metadata endpoint exists**
  - Precondition: None
  - Steps: Send `GET https://app.keeperhub.com/.well-known/oauth-authorization-server`
  - Expected: HTTP 200 with `Content-Type: application/json`

- [ ] **TC-97: Metadata contains required fields**
  - Precondition: None
  - Steps: Parse the response from TC-96
  - Expected: JSON contains `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `response_types_supported`, `grant_types_supported`, `code_challenge_methods_supported` (must include `S256`)

- [ ] **TC-98: Issuer matches the server URL**
  - Precondition: Metadata from TC-96
  - Steps: Compare `issuer` field to `https://app.keeperhub.com`
  - Expected: Values match exactly (no trailing slash discrepancy)

- [ ] **TC-99: PKCE required (S256)**
  - Precondition: Metadata from TC-96
  - Steps: Check `code_challenge_methods_supported`
  - Expected: Contains `S256`. Does not allow `plain` (or if it does, `S256` is listed and server enforces it)

- [ ] **TC-100: Scopes documented in metadata**
  - Precondition: Metadata from TC-96
  - Steps: Check for `scopes_supported` field
  - Expected: Lists available scopes (e.g., `workflows:read`, `workflows:write`, `web3:read`, `web3:write`, `plugins:*`, or equivalent)

---

## 2. Dynamic Client Registration

- [ ] **TC-101: Register a new client**
  - Precondition: Registration endpoint from metadata
  - Steps: Send `POST /register` with `{ "client_name": "UAT Test Client", "redirect_uris": ["http://localhost:3000/callback"], "grant_types": ["authorization_code"], "response_types": ["code"], "token_endpoint_auth_method": "client_secret_basic" }`
  - Expected: HTTP 201 with `client_id`, `client_secret`, and echoed registration fields

- [ ] **TC-102: Client ID is unique per registration**
  - Precondition: None
  - Steps: Register two clients with the same `client_name`
  - Expected: Each receives a distinct `client_id`

- [ ] **TC-103: Missing required fields rejected**
  - Precondition: None
  - Steps: Send `POST /register` with `{}` (empty body)
  - Expected: HTTP 400 with error indicating missing required fields (`redirect_uris` at minimum)

- [ ] **TC-104: Invalid redirect_uri rejected**
  - Precondition: None
  - Steps: Send `POST /register` with `redirect_uris: ["javascript:alert(1)"]`
  - Expected: HTTP 400 with error indicating invalid redirect URI

- [ ] **TC-105: Registration returns token_endpoint_auth_method**
  - Precondition: Successful registration
  - Steps: Inspect registration response
  - Expected: Contains `token_endpoint_auth_method` matching the requested value

---

## 3. Authorization Flow

- [ ] **TC-106: Authorization endpoint redirects to consent page**
  - Precondition: Registered client from TC-101
  - Steps: Navigate browser to `GET /authorize?response_type=code&client_id=<id>&redirect_uri=http://localhost:3000/callback&scope=workflows:read+web3:read&state=random123&code_challenge=<S256_challenge>&code_challenge_method=S256`
  - Expected: Server renders a consent/login page (or redirects to one) showing the requested scopes and client name

- [ ] **TC-107: User approves consent, receives auth code**
  - Precondition: Consent page displayed from TC-106, user is logged in
  - Steps: User clicks "Approve" on the consent page
  - Expected: Browser redirects to `http://localhost:3000/callback?code=<auth_code>&state=random123`

- [ ] **TC-108: State parameter preserved in callback**
  - Precondition: Authorization initiated with `state=random123`
  - Steps: Inspect the callback redirect URL
  - Expected: `state` query parameter equals `random123`

- [ ] **TC-109: Auth code is single-use**
  - Precondition: Auth code from TC-107
  - Steps: Exchange the code for a token (TC-112). Then try to exchange the same code again.
  - Expected: First exchange succeeds. Second exchange fails with `invalid_grant` error.

- [ ] **TC-110: Authorization without PKCE rejected**
  - Precondition: Registered client
  - Steps: Send authorization request without `code_challenge` and `code_challenge_method` parameters
  - Expected: Error response indicating PKCE is required

- [ ] **TC-111: Authorization with mismatched redirect_uri rejected**
  - Precondition: Registered client with `redirect_uris: ["http://localhost:3000/callback"]`
  - Steps: Send authorization request with `redirect_uri=http://evil.com/callback`
  - Expected: Error response. No redirect to the mismatched URI.

---

## 4. Token Exchange

- [ ] **TC-112: Exchange auth code for tokens**
  - Precondition: Auth code from TC-107, PKCE code_verifier
  - Steps: Send `POST /token` with `grant_type=authorization_code&code=<auth_code>&redirect_uri=http://localhost:3000/callback&client_id=<id>&code_verifier=<verifier>`
  - Expected: HTTP 200 with `access_token`, `token_type: "bearer"`, `expires_in`, `refresh_token`, and `scope`

- [ ] **TC-113: Access token works for MCP initialize**
  - Precondition: Access token from TC-112
  - Steps: Send `POST /mcp` with `Authorization: Bearer <access_token>` and `initialize` method
  - Expected: HTTP 200 with valid initialize response and `Mcp-Session-Id`

- [ ] **TC-114: Access token works for tools/call**
  - Precondition: Session from TC-113
  - Steps: Call `tools/call` with `name: "workflow_list"`
  - Expected: Response contains workflow list for the authorized org

- [ ] **TC-115: Wrong code_verifier rejected**
  - Precondition: Auth code from TC-107
  - Steps: Send `POST /token` with an incorrect `code_verifier`
  - Expected: HTTP 400 with `invalid_grant` error. No tokens issued.

- [ ] **TC-116: Expired auth code rejected**
  - Precondition: Auth code obtained, then wait for expiry (typically 10 minutes)
  - Steps: Send `POST /token` with the expired code
  - Expected: HTTP 400 with `invalid_grant` error

- [ ] **TC-117: Token response does not include credentials in URL**
  - Precondition: Successful token exchange
  - Steps: Verify the token endpoint response
  - Expected: Tokens are in the response body only, never in URL parameters or headers that could be logged

---

## 5. Token Refresh

- [ ] **TC-118: Refresh token obtains new access token**
  - Precondition: Refresh token from TC-112
  - Steps: Send `POST /token` with `grant_type=refresh_token&refresh_token=<refresh_token>&client_id=<id>`
  - Expected: HTTP 200 with new `access_token`, `expires_in`, and optionally a new `refresh_token`

- [ ] **TC-119: Old access token invalid after refresh**
  - Precondition: New access token from TC-118
  - Steps: Use the old access token from TC-112 to call `POST /mcp` with `initialize`
  - Expected: Either still works (if not rotated) or returns 401. Behavior should be documented.

- [ ] **TC-120: Refresh token rotation (if supported)**
  - Precondition: Refresh performed in TC-118 returned a new refresh_token
  - Steps: Use the old refresh_token again
  - Expected: Rejected. Old refresh token is invalidated after rotation.

- [ ] **TC-121: Invalid refresh token rejected**
  - Precondition: None
  - Steps: Send `POST /token` with `grant_type=refresh_token&refresh_token=invalid_garbage`
  - Expected: HTTP 400 with `invalid_grant` error

- [ ] **TC-122: Refresh preserves scope**
  - Precondition: Original token had `scope: "workflows:read web3:read"`
  - Steps: Refresh the token. Inspect the new token's scope.
  - Expected: New token has the same scope as the original

---

## 6. Scoped Permissions

- [ ] **TC-123: Read-only scope cannot write**
  - Precondition: OAuth token with scope `workflows:read` only
  - Steps: Initialize MCP session. Call `workflow_create`.
  - Expected: JSON-RPC error indicating insufficient permissions/scope

- [ ] **TC-124: Read-only scope can read**
  - Precondition: OAuth token with scope `workflows:read` only
  - Steps: Initialize MCP session. Call `workflow_list`.
  - Expected: Success. Returns workflow list.

- [ ] **TC-125: Web3 read scope cannot write**
  - Precondition: OAuth token with scope `web3:read` only
  - Steps: Call `web3_transfer-funds`
  - Expected: JSON-RPC error indicating insufficient permissions

- [ ] **TC-126: Web3 read scope can read**
  - Precondition: OAuth token with scope `web3:read` only
  - Steps: Call `web3_check-balance`
  - Expected: Success

- [ ] **TC-127: Per-plugin scope restricts to specific plugins**
  - Precondition: OAuth token with scope `plugins:aave` (only Aave tools authorized)
  - Steps: Call `aave_get-user-account-data` (should work). Call `uniswap_swap-exact-input` (should fail).
  - Expected: Aave read succeeds. Uniswap write rejected with insufficient scope.

- [ ] **TC-128: Full scope grants all access**
  - Precondition: OAuth token with all scopes
  - Steps: Call `workflow_create`, `web3_transfer-funds`, `aave_supply`
  - Expected: All succeed (subject to spending caps and other non-auth restrictions)

- [ ] **TC-129: Requesting unknown scope**
  - Precondition: Registered client
  - Steps: Authorization request with `scope=nonexistent:scope`
  - Expected: Error response indicating invalid scope, or scope silently dropped and not included in token

- [ ] **TC-130: Scope downgrade on refresh not allowed**
  - Precondition: Token with scope `workflows:read workflows:write`
  - Steps: Refresh with `scope=workflows:read workflows:write web3:write` (requesting additional scope)
  - Expected: Rejected or scope limited to original grant. Cannot escalate permissions via refresh.

---

## 7. OAuth + MCP Integration (End-to-End)

- [ ] **TC-131: Full OAuth flow to tool call**
  - Precondition: None (start from scratch)
  - Steps:
    1. Register client via `POST /register`
    2. Initiate authorization with PKCE
    3. User logs in and approves consent
    4. Exchange auth code for tokens
    5. Initialize MCP session with access token
    6. Call `tools/list`
    7. Call `tools/call` with `workflow_list`
  - Expected: Every step succeeds. Workflow list returned at the end.

- [ ] **TC-132: OAuth session survives token refresh**
  - Precondition: Active MCP session from OAuth token
  - Steps: Wait for access token to expire (or simulate). Refresh the token. Continue using the MCP session with the new token.
  - Expected: MCP session continues without re-initialization. Alternatively, if session is invalidated, client can re-initialize with the new token.

- [ ] **TC-133: Revoke OAuth token terminates MCP session**
  - Precondition: Active MCP session from OAuth token, revocation endpoint available
  - Steps: Revoke the access token. Then call `tools/list` with the MCP session.
  - Expected: Request fails with auth error. Session is no longer valid.

- [ ] **TC-134: Multiple OAuth clients with separate sessions**
  - Precondition: Two registered OAuth clients for the same org
  - Steps: Each client completes the OAuth flow and initializes a separate MCP session. Each calls `workflow_list`.
  - Expected: Both succeed independently. Each has its own session. Data returned is for the same org.

---

## 8. Backward Compatibility

- [ ] **TC-135: kh_ API keys still work after OAuth is enabled**
  - Precondition: OAuth fully deployed, existing `kh_` API key
  - Steps: Send `POST /mcp` with `Authorization: Bearer kh_...` and `initialize` method
  - Expected: HTTP 200. Session created. All tools accessible as before.

- [ ] **TC-136: kh_ key and OAuth token coexist**
  - Precondition: One session with `kh_` key, another with OAuth token, both for the same org
  - Steps: Both sessions call `workflow_list`
  - Expected: Both return the same org's workflows. Sessions are independent.

- [ ] **TC-137: kh_ key not subject to OAuth scopes**
  - Precondition: `kh_` API key session
  - Steps: Call `workflow_create`, `web3_transfer-funds`, and protocol tools
  - Expected: All succeed. `kh_` keys have full access (scoping is OAuth-only). Subject to spending caps.

- [ ] **TC-138: OAuth token format distinguishable from kh_ key**
  - Precondition: Both token types available
  - Steps: Server receives `Authorization: Bearer <token>`. Inspect server behavior.
  - Expected: Server correctly identifies whether the token is a `kh_` key or an OAuth access token and routes authentication accordingly. No ambiguity.

- [ ] **TC-139: Existing Claude Code kh_ configs unchanged**
  - Precondition: Claude Code configured with `kh_` key (from v1 TC-50)
  - Steps: After OAuth deployment, use Claude Code with the existing configuration
  - Expected: Everything works exactly as before. No config changes needed.
