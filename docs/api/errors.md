---
title: "Error Codes"
description: "KeeperHub API error codes and troubleshooting guide."
---

# Error Codes

Reference for API error codes and how to resolve them.

## Error Response Format

Errors return a flat JSON envelope:

```json
{
  "error": "invalid_input",
  "detail": "Human readable description of what went wrong",
  "request_id": "b3c1e2f0-2a4d-4a1e-9c3f-0f2b7c1d5e6a"
}
```

| Field | Description |
|-------|-------------|
| `error` | Stable, machine-readable code (see below) |
| `detail` | Human-readable description of the failure |
| `request_id` | Correlation id, also echoed on the `x-request-id` response header |
| `hint` | Optional actionable next step (present on some errors) |
| `docs` | Optional link to relevant documentation (present on some errors) |

## HTTP Status Codes

| Status | Description |
|--------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid authentication |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource does not exist |
| 409 | Conflict - Idempotency-Key reused or request already in progress |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

## Error Codes

The API uses a short set of stable, lowercase codes in the `error` field. Some routes add a more specific code (for example `WALLET_NOT_CONFIGURED` on execution routes); those are documented alongside the endpoint that raises them.

| Code | HTTP status | Meaning | Resolution |
|------|-------------|---------|------------|
| `unauthorized` | 401 | Missing or invalid authentication | Include a valid session cookie or API key |
| `insufficient_scope` | 403 | The session or key lacks the required scope | Use a key with the needed scope |
| `invalid_input` | 400 | Request validation failed | Check required fields and formats |
| `not_found` | 404 | Resource does not exist or is not visible to you | Verify the resource id |
| `conflict` | 409 | Request conflicts with the current state | Reconcile and retry |
| `rate_limited` | 429 | Too many requests | Back off and retry (see rate-limit headers below) |
| `internal_error` | 500 | Unexpected server error | Retry with backoff; contact support if it persists |

### Idempotency Errors

Both codes answer `409` and mean opposite things, so the status does not separate
them. These two responses carry `retryable`, which answers one narrow question:
**is it safe to send this request again under the same `Idempotency-Key`?**

| Code | `retryable` | Description | Resolution |
|------|-------------|-------------|------------|
| `idempotency_conflict` | `false` | The `Idempotency-Key` was reused with a different request body. Response includes `originalExecutionId`. | Rotate to a **new** key only if this is genuinely different work. If it is the same intent whose body was re-serialized, canonicalize the body and keep the key. |
| `idempotency_in_progress` | `true` | A request with this `Idempotency-Key` is still being processed | Retry shortly under the **same** key |

```json
{
  "error": "A request with this Idempotency-Key is already being processed. Retry the same key shortly; do not rotate it.",
  "code": "idempotency_in_progress",
  "retryable": true
}
```

`retryable: false` on a conflict does not mean give up, and it does not mean
rotate-and-resend either. It means this body is not the body the key was bound
to, and that has two causes wanting opposite responses. If the work is genuinely
different, use a new key. If it is the same intent serialized differently —
`"0.1"` against `"0.10"`, `network` in place of `chainId`, a reworded memo — then
the body drifted, not the intent: canonicalize the body and keep the key.
Rotating there escapes the in-flight guard on a request that may already have
broadcast, and on these routes that pays twice.

The field appears on these two codes only. Every other status on these routes
keeps the semantics documented above, whether or not `retryable` is present: a
`429` is still back-off-and-retry, and a `500` is still worth another attempt
**under the same key** — a `5xx` tells you nothing about whether the request was
received, so the retry has to be able to match the original.

See [Direct Execution](/api/direct-execution#idempotency) for the full idempotency policy.

### Workflow run failures

Failures that occur while a workflow run executes, rather than while handling an API request, are surfaced in the run logs with a separate stable code of the form `PREFIX-NNNN` (for example `E-0001` for a run timeout). See [Run Error Codes](/keeper-runs/error-codes) for the full list.

## Rate Limiting

A `rate_limited` error (HTTP `429`) means you have exceeded the request budget for the endpoint. Back off and retry using the rate-limit headers below.

#### Rate-limit headers

Every response from a rate-limited endpoint (both success and `429`) carries the current limiter state, so clients can pace requests instead of guessing:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests left in the current window |
| `X-RateLimit-Reset` | Unix epoch (seconds) when the window frees a slot |
| `Retry-After` | Seconds to wait before retrying (sent only on `429`) |

Status and long-poll endpoints additionally return `X-Poll-Interval-Hint`: the server-recommended number of seconds to wait before polling again. A value of `0` means the resource has reached a terminal state and no further polling is needed.

> Anti-abuse endpoints (for example password reset and MFA enrollment) intentionally omit `X-RateLimit-Remaining` so they don't disclose a caller's remaining attempt budget. They still send `Retry-After` on `429`.

## Retry Strategy

For transient errors (5xx, rate limits), use exponential backoff:

```
Wait time = min(base * 2^attempt, max_wait)
```

Recommended:
- Base: 1 second
- Max attempts: 5
- Max wait: 30 seconds
