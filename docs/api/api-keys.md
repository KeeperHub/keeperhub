---
title: "API Keys"
description: "KeeperHub API Keys - create and manage API keys for programmatic access."
---

# API Keys

Manage API keys for programmatic access to the KeeperHub API.

## Key Types

KeeperHub has two distinct key systems, managed at different endpoints. They are not interchangeable.

| Prefix | Scope | Managed at | Used for |
|--------|-------|------------|----------|
| `kh_` | Organization | `/api/keys` | REST API, MCP server, Claude Code plugin |
| `wfb_` | User | `/api/api-keys` | Webhook triggers |

For typical programmatic API access use organization (`kh_`) keys.

## Organization Keys (`kh_`)

Issued per-organization. Create them from Settings > Developer > API keys > Organisation keys in the dashboard, or via the endpoints below.

### List Organization Keys

```http
GET /api/keys
```

Accepts session or API-key authentication. Returns a paginated list of non-revoked keys for the active organization. Use the `page` (1-based) and `limit` query parameters to page through results.

#### Response

```json
{
  "items": [
    {
      "id": "key_123",
      "name": "Production Key",
      "keyPrefix": "kh_a1B2c",
      "createdAt": "2024-01-01T00:00:00Z",
      "lastUsedAt": "2024-01-15T12:00:00Z",
      "expiresAt": null,
      "scope": "mcp:read mcp:write",
      "createdByName": "Jane Doe",
      "createdByEmail": "jane@example.com",
      "createdByRole": "admin"
    }
  ],
  "meta": { "total": 1, "page": 1, "pageSize": 50, "totalPages": 1 },
  "_links": {
    "self": "/api/keys?page=1&limit=50",
    "first": "/api/keys?page=1&limit=50",
    "prev": null,
    "next": null,
    "last": "/api/keys?page=1&limit=50"
  }
}
```

`keyPrefix` is the first 8 characters of the key (`kh_` plus 5 more), kept for identification. The full key is never returned after creation.

### Create Organization Key

```http
POST /api/keys
```

**Session authentication required.** Cannot be invoked with an API key. Otherwise a leaked key could mint additional keys for the same organization.

**Admin or owner required.** Key creation and revocation enforce an organization role floor of admin. The role is checked before the step-up below, so a member receives `403` with `code: "not_admin_or_owner"` and is never issued a challenge - no signature will resolve it.

**Step-up confirmation required.** Key creation sits behind the same confirmation gate as wallet withdrawals: the first request returns `401` with `code: "signature_required"` and a `challenge` to sign (or `factors_required` when a non-wallet factor is outstanding). The dashboard handles this with a wallet popup or an authenticator prompt. Scripted clients must answer it themselves - see [Headless Onboarding](/api/headless-onboarding#2-create-an-organization-api-key) for the retry protocol.

#### Request Body

```json
{
  "name": "My API Key",
  "expiresAt": "2025-01-01T00:00:00Z",
  "scopes": ["mcp:read", "mcp:write"]
}
```

`expiresAt` is optional. Omit for a non-expiring key.

`scopes` is optional and accepts either an array of scope strings or a single space-separated string. Valid values are `mcp:read`, `mcp:write`, and `mcp:admin`; unrecognized entries are dropped, and a request whose entries are all unrecognized falls back to `mcp:read` rather than granting more. The scope is enforced on every endpoint that declares a requirement, including the [Direct Execution API](/api/direct-execution) - a key scoped `mcp:read` can read and simulate but cannot broadcast, and receives `403` with `error: "insufficient_scope"` if it tries. Omit `scopes` entirely for a key with no scope restriction, which passes every gate. The scope a key was created with is returned by the List endpoint and cannot be changed afterwards; create a new key instead.

#### Response

```json
{
  "id": "key_123",
  "name": "My API Key",
  "key": "kh_full_api_key_here",
  "keyPrefix": "kh_full_",
  "createdAt": "2024-01-01T00:00:00Z",
  "expiresAt": null
}
```

Copy the `key` value immediately. It is only shown once.

### Revoke Organization Key

```http
DELETE /api/keys/{keyId}
```

Soft-revokes the key. Subsequent requests with that key return `401`.

Revocation is behind the same `org_api_key_manage` step-up gate as creation: the
first `DELETE` returns `401 signature_required` with a challenge to sign.

#### Response

```json
{
  "success": true
}
```

## User Keys (`wfb_`)

Issued per-user. Intended for webhook triggers, not for general REST API access.

### List User Keys

```http
GET /api/api-keys
```

Session authentication required.

### Create User Key

```http
POST /api/api-keys
```

Session authentication required.

#### Request Body

```json
{
  "name": "My Webhook Key"
}
```

### Delete User Key

```http
DELETE /api/api-keys/{keyId}
```

Session authentication required. Revokes the key. This action cannot be undone.

## Security Notes

- Keys are hashed with SHA256 before storage; only the prefix is kept for identification.
- Anonymous users cannot create API keys.
- Revoke compromised keys immediately.
- Store keys in environment variables, not in source code.
- Key creation and personal-key deletion require session authentication, so a leaked API key cannot mint or delete other keys.
