---
title: "Authentication"
description: "KeeperHub API authentication methods - session auth and API keys."
---

# Authentication

The KeeperHub API supports two authentication methods. They are not interchangeable: their accepted scopes differ. See [Endpoint scope](#endpoint-scope) for the rules.

## Session Authentication

For browser-based applications, authentication is handled via Better Auth session cookies. Users authenticate through the standard login flow at `app.keeperhub.com`.

## API Key Authentication

For programmatic access, use API keys in the `Authorization` header:

```bash
curl -H "Authorization: Bearer kh_your_api_key" \
  https://app.keeperhub.com/api/workflows
```

### Key Types

KeeperHub has two types of API keys:

| Prefix | Scope | Created in | Used for |
|--------|-------|------------|----------|
| `kh_` | Organization | Settings > Developer > API keys > Organisation keys | REST API, MCP server, Claude Code plugin |
| `wfb_` | User | Settings > Developer > API keys > Webhook keys | Webhook triggers |

### Creating API Keys

1. Open Settings in the KeeperHub dashboard
2. Under Developer, select "API keys"
3. Use "Organisation keys" for `kh_` keys, or "Webhook keys" for `wfb_` keys
4. Create the key
5. Copy the key immediately. It will only be shown once.

Creating organization keys is limited to owners and admins. Any member can
create a webhook key.

### Key Security

- Keys are hashed with SHA256 before storage
- Only the key prefix is stored for identification
- Revoke keys immediately if compromised

## Checking a key works

Use `GET /api/keys` as the probe in a health check or first-run script. It is
organization-scoped, read-only, and returns `keyPrefix` for each key, so a
diagnostic can name the key it is holding without printing it.

```bash
curl -sf -H "Authorization: Bearer kh_your_api_key" \
  https://app.keeperhub.com/api/keys
```

A `200` means the credential is valid and scoped to an organization. A `401`
means the key is wrong, revoked, or absent.

`GET /api/chains` serves the chain catalog to anyone, credential or not, because
the list is public information. It answers `200` for an invalid key as readily
as a valid one, so it tells you the host is reachable rather than that your
credential works. Reach for it to check connectivity, and for `GET /api/keys`
to check authentication.

## Endpoint scope

Session authentication is accepted everywhere. API keys (`kh_`) are accepted only on **organization-scoped** endpoints, the ones whose action and result depend on the caller's organization rather than on the individual user behind the key. Wallets, billing, and spending caps are all attached to the organization, so a key that authorizes on-chain spend or billable usage is necessarily organization-scoped.

### Accepted on API keys

Endpoints whose semantics are organization-scoped accept `kh_` keys:

- Workflow CRUD and execution: `/api/workflows`, including
  `POST /api/workflows/{workflowId}/execute` and execution history and status
  (`GET /api/workflows/{workflowId}/executions` and
  `GET /api/workflows/executions/{executionId}/{status,logs,wait}`), and
  listing (`PUT /api/workflows/{workflowId}/go-live`).
  A few sub-paths are session-only; see [Session-only](#session-only) below
- Execution cancellation: `POST /api/executions/{executionId}/cancel`
- Direct execution: everything under `/api/execute` - `/transfer`,
  `/contract-call`, `/check-and-execute`, `/swap`, `/node`, protocol actions
  (`/api/execute/{protocol}/{action}`), and
  `GET /api/execute/{executionId}/status`
- Integrations: `/api/integrations`
- Projects, tags, public tags, supported chains (`GET /api/chains` serves the
  chain catalog to anyone, with or without a credential; see
  [Checking a key works](#checking-a-key-works))
- Organization-scoped billing and analytics
- Organization management (e.g. renaming an organization)
- Organization API keys (`GET /api/keys`, `DELETE /api/keys/{keyId}`); creation requires session
- Address book entries (organization-scoped)

### Session-only

Endpoints that act on a user account, hold credential material, or sit on a human approval boundary require session authentication. API keys are rejected with `401`:

- **User-account operations**: profile mutation (`PATCH /api/user`), password change, account deactivation, forgot-password
- **Per-user preferences**: RPC preferences
- **Wallet write operations**: provisioning, deletion, withdrawal, fee estimation, switching the active signing wallet, retrieving or refreshing the user share, and private-key export
- **Authentication primitives**: creating organization API keys (`POST /api/keys`), creating/listing/deleting personal webhook keys (`/api/api-keys/*`), AI Gateway OAuth flows
- **Human-in-the-loop wallet approvals**: agentic-wallet linking and approve/reject endpoints
- **Per-user state**: workflow drafts, workflow ratings, leaving an organization

If you have a use case for session-only behavior over an API key, open an issue describing it. The boundary is deliberate: it keeps a leaked API key from escalating into account control or wallet drainage.

### Webhook keys

Workflow webhook triggers (`POST /api/workflows/{workflowId}/webhook`) accept only user-scoped (`wfb_`) keys. The route reads the `Authorization` header directly; session cookies are not consulted, and `kh_` keys are rejected with `401`. The `wfb_` key must belong to a member of the target workflow's organization: a key from outside that organization is rejected with `403`, and a key whose user cannot access the workflow returns `404`. Webhook executions are attributed to the individual triggering user rather than to the organization.

## Deactivated accounts

Deactivating a user account from the dashboard immediately revokes the credentials that user holds, across every supported auth method:

- **Sessions** are deleted server-side. The user is signed out everywhere they were logged in.
- **Organization API keys** (`kh_`) the user created are soft-revoked (`revokedAt` is stamped). Subsequent requests with those keys return `401`.
- **MCP OAuth tokens** for the user are rejected at the next request, even if their TTL has not yet elapsed.

There is currently no reactivation flow. If a deactivated user wants to come back, they sign up again and provision new credentials.

## Webhook Authentication

For webhook triggers, use a user-scoped key (`wfb_`) with the workflow-specific webhook URL:

```bash
POST /api/workflows/{workflowId}/webhook
Authorization: Bearer wfb_your_api_key
```
