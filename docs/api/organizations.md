---
title: "Organizations API"
description: "KeeperHub Organizations API - manage organization membership."
---

# Organizations API

Manage organization membership programmatically.

## Leave Organization

```http
POST /api/organizations/{organizationId}/leave
```

Remove yourself from an organization. If you are the sole owner, you must transfer ownership by providing `newOwnerMemberId` in the request body. The new owner must be an accepted member of the organization.

### Request Body

```json
{
  "newOwnerMemberId": "member_456"
}
```

The `newOwnerMemberId` field is only required when you are the last remaining owner.

## Resolve a Disbursement Leg

```http
POST /api/organizations/{organizationId}/disbursement-legs/{runKey}/{legIndex}/resolve
```

For an API-key or OAuth caller, `{organizationId}` may be the literal `self` to mean the credential's own organization -- useful when the caller has no other way to learn its organization id.

Records an operator's answer for one leg of a `web3/disburse` run that the platform could not resolve on its own: a leg whose outcome is `unknown` (it may have paid — the platform could not confirm it, so it was never sent again), or one stuck `sending` whose run is presumed dead. Every other leg state settles or fails from the run itself, and this endpoint refuses to touch it.

Requires `mcp:write` scope (or a session belonging to the organization). Resolving a leg is recorded to the organization's audit log.

### Request Body

```json
{
  "outcome": "paid",
  "transactionHash": "0x...",
  "note": "Found the transfer on Basescan, block 12345678"
}
```

- `outcome`: `"paid"` or `"not_paid"`, required.
- `transactionHash`: required when `outcome` is `"paid"` — the transaction that proves it.
- `note`: required for either outcome — what you checked.

### Response

```json
{
  "leg": {
    "organizationId": "org_123",
    "runKey": "payroll-2026-09",
    "legIndex": 0,
    "status": "settled",
    "transactionHash": "0x...",
    "resolvedBy": "user_456",
    "resolutionNote": "Found the transfer on Basescan, block 12345678",
    "resolvedAt": "2026-09-17T12:00:00Z"
  }
}
```

Resolving as paid moves the leg to `settled`; resolving as not paid moves it to `failed`, so the next run with the same `runKey` sends it again. `404` when the run or leg does not exist, `400` for a malformed body, `409` when the leg is not in a resolvable state (already settled, or still actively `sending`).
