---
title: "API Overview"
description: "KeeperHub REST API reference - authentication, endpoints, rate limits, and SDKs."
---

# API Overview

The KeeperHub API allows you to programmatically manage workflows, integrations, and executions.

## Base URL

```
https://app.keeperhub.com
```

Endpoint paths throughout this reference are written with the `/api` prefix
already included (for example `POST /api/workflows/create`). Append them to the
base above exactly as shown. Setting a client's base URL to
`https://app.keeperhub.com/api` and then appending a documented path produces a
doubled `/api/api` prefix and a 404.

That particular 404 names itself, so you do not have to guess. It answers with
`error: "doubled_api_prefix"` and a `hint` carrying the corrected path:

```json
{
  "error": "doubled_api_prefix",
  "detail": "Route GET /api/api/chains not found. The path is doubled: it contains /api twice.",
  "hint": "Your base URL already includes /api. Drop it from the base URL, or call /api/chains instead."
}
```

## Authentication

API requests require authentication. Two methods are supported, but their accepted scope differs:

- **Session**: Browser-based authentication via Better Auth. Accepted on every endpoint.
- **API Key** (`kh_`): For programmatic access to organization-scoped endpoints (workflows, integrations, billing, organization management). Not accepted on user-account, wallet write, OAuth-account-bound, or per-user endpoints.

See [Authentication](/api/authentication) for the full scope.

## Response Format

All responses are JSON. Successful responses come in three shapes, by resource
kind. There is no `data` wrapper on any endpoint.

### Single resource

A read or write of one resource returns that resource as a bare object.

```json
{
  "id": "wf_123",
  "name": "Treasury monitor"
}
```

`GET /api/user`, `GET /api/workflows/{workflowId}` and the direct-execution
endpoints all answer this way.

### Paginated collection

A collection that paginates returns items alongside page metadata and links.

```json
{
  "items": [ ... ],
  "meta": { "total": 42, "page": 1, "pageSize": 20, "totalPages": 3 },
  "_links": {
    "self": "...", "first": "...", "prev": null, "next": "...", "last": "..."
  }
}
```

`GET /api/keys`, `GET /api/workflows/{workflowId}/history` and
`GET /api/security/audit` answer this way. Read `items`, and follow
`_links.next` until it is `null`.

### Bare array

List endpoints that do not paginate return a plain JSON array with no envelope.
`GET /api/chains` and `GET /api/workflows` both answer this way.

```json
[
  { "chainId": 1, "name": "Ethereum Mainnet" }
]
```

When writing a generic client, key the unwrapping on the endpoint rather than
sniffing the body.

### Error Response

Errors return JSON of the form:

```json
{
  "error": "wallet_not_configured",
  "detail": "No wallet provisioned for chain 8453 in org acme",
  "hint": "POST /api/integrations/wallet to provision a wallet for this org",
  "docs": "https://docs.keeperhub.com/api/integrations",
  "request_id": "5f5a7d4e-4f4f-4d6b-9c9a-3f7b1c0d2e1f"
}
```

Fields:

| Field        | Type   | Description                                                                                                                  |
|--------------|--------|------------------------------------------------------------------------------------------------------------------------------|
| `error`      | string | Machine-readable, stable `snake_case` code. Branch on this — never on `detail` prose.                                        |
| `detail`     | string | Human-readable description of what went wrong. Safe to log or surface in developer tools, but not user-facing copy.          |
| `hint`       | string | Optional. Suggested recovery action (e.g. which endpoint to call, which field to fix).                                       |
| `docs`       | string | Optional. URL to the doc page that explains this error in depth.                                                             |
| `request_id` | string | Correlation id for the request. Echoed back on the `x-request-id` response header. Quote this in support tickets.            |

Clients should:

- Branch on `error` only. Copy in `detail` and `hint` may change without notice.
- Tolerate the absence of `hint` and `docs`.
- Capture `request_id` (or read the `x-request-id` response header) and include it when reporting issues.

A short list of canonical `error` codes is reused across endpoints: `unauthorized`, `insufficient_scope`, `not_found`, `invalid_input`, `conflict`, `rate_limited`, `internal_error`. Endpoint-specific codes (e.g. `wallet_not_configured`, `web3_integration_exists`) are documented on the page for the resource that raises them.

### Direct Execution errors

The `/api/execute/*` endpoints answer with a human-readable sentence in `error`,
`field` naming the offending input where one applies, and `details` carrying
context. Where a machine-readable code exists it is in `code`, for example
`insufficient_balance` on a simulation that ran out of native currency. Branch
on the HTTP status and on `code`, and treat `error` there as prose to log or
show. See [Direct Execution](/api/direct-execution) for the per-endpoint shapes.

The `x-request-id` request header is honored when present: send any value (≤ 128 chars, no control characters) and it is reflected back on both the `request_id` response field and the `x-request-id` response header.

## Rate Limits

API requests are subject to rate limiting. Current limits:
- 100 requests per minute for authenticated users
- 10 requests per minute for unauthenticated requests

## Available Endpoints

| Resource | Description |
|----------|-------------|
| [Workflows](/api/workflows) | Create, read, update, delete workflows |
| [Executions](/api/executions) | Monitor workflow execution status and logs |
| [Direct Execution](/api/direct-execution) | Execute blockchain transactions without workflows |
| [Analytics](/api/analytics) | Workflow performance metrics and gas usage tracking |
| [Integrations](/api/integrations) | Manage notification and service integrations |
| [Projects](/api/projects) | Organize workflows into projects |
| [Tags](/api/tags) | Label and categorize workflows |
| [Chains](/api/chains) | List supported blockchain networks |
| [User](/api/user) | User profile, preferences, and address book |
| [Organizations](/api/organizations) | Organization membership management |
| [API Keys](/api/api-keys) | Manage API keys for programmatic access |

## SDKs

Official SDKs are planned for future release. In the meantime, you can interact with the API directly using any HTTP client or library such as `fetch`, `axios`, or `requests`.
