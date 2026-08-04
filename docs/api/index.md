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

## Authentication

API requests require authentication. Two methods are supported, but their accepted scope differs:

- **Session**: Browser-based authentication via Better Auth. Accepted on every endpoint.
- **API Key** (`kh_`): For programmatic access to organization-scoped endpoints (workflows, integrations, billing, organization management). Not accepted on user-account, wallet write, OAuth-account-bound, or per-user endpoints.

See [Authentication](/api/authentication) for the full scope.

## Response Format

All responses are returned as JSON with the following structure:

### Success Response
```json
{
  "data": { ... }
}
```

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
