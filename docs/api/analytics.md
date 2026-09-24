---
title: "Analytics API"
description: "KeeperHub Analytics API - monitor workflow performance, gas usage, and execution trends."
---

# Analytics API

The Analytics API provides insights into workflow and direct execution performance, gas usage, and execution trends across your organization.

## Authentication

All analytics routes accept either a session cookie or an organization API key (`Authorization: Bearer $KEEPERHUB_API_KEY`) except the two that are session-only:

- **`GET /api/analytics/summary`**, **`GET /api/analytics/time-series`**, **`GET /api/analytics/networks`**, **`GET /api/analytics/runs`**, and **`GET /api/analytics/spend-cap`** accept a `kh_` organization key with the `mcp:read` scope. A legacy key with no scope is admitted (an unscoped key means full access). A session caller carries no scope and is unaffected - the scope gate applies to key callers only.
- **`GET /api/analytics/stream`** is session-only: it is a server-sent-events feed consumed by a browser `EventSource`, which cannot send an `Authorization` header, so a key has no way to use it.
- **`GET /api/analytics/runs/{executionId}/steps`** is session-only: it reads the caller's organization from the session.

## Get Analytics Summary

```http
GET /api/analytics/summary
```

Returns aggregated analytics for the organization including run counts, success rates, and gas usage.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `range` | string | Time range: `1h`, `24h`, `7d`, `30d`, `custom` (default: `24h`). An unrecognised value is not rejected: `?range=90d` falls through to the `24h` offset |
| `customStart` | string | ISO timestamp for custom range start |
| `customEnd` | string | ISO timestamp for custom range end |
| `projectId` | string | Restrict the figures to one workflow project. It also removes direct executions from the response entirely, so `totalRuns` and `totalGasWei` lose their direct half. `sponsoredGasWei` is workflow-only on every request and has no direct half to lose: the parameter narrows it to the project rather than halving it |

### Response

```json
{
  "totalRuns": 1250,
  "successCount": 1180,
  "errorCount": 70,
  "cancelledCount": 0,
  "skippedCount": 0,
  "successRate": 0.944,
  "avgDurationMs": 2340,
  "totalGasWei": "15000000000000000",
  "sponsoredGasWei": "2000000000000000",
  "activeRuns": 3,
  "previousPeriod": {
    "totalRuns": 1180,
    "successCount": 1100,
    "errorCount": 80,
    "cancelledCount": 0,
    "skippedCount": 0,
    "avgDurationMs": 2510,
    "totalGasWei": "14000000000000000",
    "sponsoredGasWei": "1800000000000000"
  }
}
```

**Field Definitions**

| Field | Type | Description |
|-------|------|-------------|
| `totalRuns` | number | `successCount + errorCount`. Runs that are still pending or running are not counted, and neither are the runs that were cancelled or skipped, so this is not the total of every row List Runs returns. The four figures do not sum to it, deliberately |
| `successCount` | number | Runs that completed successfully |
| `errorCount` | number | Runs that failed |
| `cancelledCount` | number | Workflow runs that were cancelled |
| `skippedCount` | number | Workflow runs with status `skipped`, which is a run the platform refused before it started: over the plan limit, a gated action, or an unpaid pay-as-you-go charge |
| `successRate` | number | Fraction of runs that succeeded, `0` to `1`, not a percentage. The dashboard renders it by multiplying by 100, so a consumer that wants a percentage has to do the same |
| `avgDurationMs` | number or null | Mean duration in milliseconds, or `null` when the window holds no completed run to average |
| `totalGasWei` | string | Every wei the runs burned over the range, sponsored gas included. A decimal string, because the figure overflows a JavaScript number |
| `sponsoredGasWei` | string | The sponsored portion of `totalGasWei`, read from the gas-credit ledger. A subset rather than a second figure: adding the two double counts, and the wallet-paid share is the subtraction |
| `activeRuns` | number | Runs in flight at the moment of the request, counted for the organization rather than the window. Under `projectId` it is scoped to that project and covers workflow runs only, because the direct-execution count is skipped when the parameter is set |
| `previousPeriod` | object | The same counts over the window immediately before this one, so a caller can render deltas. It carries `totalRuns`, `successCount`, `errorCount`, `cancelledCount`, `skippedCount`, `avgDurationMs`, `totalGasWei` and `sponsoredGasWei`, and deliberately not `successRate` or `activeRuns`: derive the previous rate from its own `successCount / totalRuns` |

## Get Time Series Data

```http
GET /api/analytics/time-series
```

Returns time-bucketed run counts for charting execution volume over time.

Bucket width is chosen from the width of the window: 5 minutes up to 2 hours,
1 hour up to 2 days, 6 hours up to 14 days, and 1 day beyond that. Every bucket
in the window is returned, including the ones with no runs.

### Query Parameters

Same as the summary endpoint, plus:

| Parameter | Type | Description |
|-----------|------|-------------|
| `tz` | string | IANA time zone the buckets are truncated in, for example `Europe/Berlin` (default: `UTC`). An unrecognised value falls back to `UTC`. |

### Response

```json
{
  "intervalMs": 86400000,
  "buckets": [
    {
      "timestamp": "2024-01-01T00:00:00Z",
      "success": 40,
      "error": 2,
      "cancelled": 0,
      "skipped": 0,
      "pending": 0,
      "running": 0
    }
  ]
}
```

`timestamp` is the instant the bucket starts, so with `tz=Europe/Berlin` a daily
bucket starts at midnight Berlin time rather than midnight UTC.

## Get Network Breakdown

```http
GET /api/analytics/networks
```

Returns execution counts and gas usage grouped by blockchain network. Gas totals include both workflow executions and direct executions on each network.

### Query Parameters

Same as the summary endpoint, including `projectId`: it excludes direct executions rather than filtering them, so every network row loses its direct half.

### Response

```json
{
  "networks": [
    {
      "network": "8453",
      "executionCount": 380,
      "successCount": 372,
      "errorCount": 8,
      "totalGasWei": "2500000000000000"
    }
  ]
}
```

`network` is whatever the step recorded, and the API does not normalise it: a chain id as a string on most rows, and on the rest either the slug a plugin wrote (`tempo-testnet`, stored verbatim rather than resolved through the chain registry) or the literal `unknown` when the row recorded nothing. It is not a display name and nothing on this endpoint maps it to one, so treat it as an opaque key: `Number(network)` is `NaN` on the slug rows and on `unknown`. The display-name mapping lives in the runs table, in a different surface.

`executionCount` is not a run count on the workflow half. The direct half counts direct executions that reached `completed` or `failed`, but the workflow half has no run-status predicate: it counts every `workflow_execution_logs` row that recorded gas, which is one per gas-bearing step, including steps of a run that is still in progress. `successCount` and `errorCount` on that half are step statuses for the same reason. Summing `executionCount` across networks therefore gives settled direct executions plus gas-bearing workflow steps, which is what this Gas Breakdown table shows, rather than run volume.

## List Runs

```http
GET /api/analytics/runs
```

Returns a unified list of both workflow executions and direct executions with pagination.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `range` | string | Time range filter (same as summary) |
| `customStart` | string | ISO timestamp for custom range start |
| `customEnd` | string | ISO timestamp for custom range end |
| `status` | string | Filter by status. Repeatable. One of `pending`, `running`, `success`, `error`, `system_error`, `external_error`, `skipped`, `cancelled` |
| `source` | string | Filter by source: `workflow`, `direct`. Repeatable |
| `network` | string | Restrict to these networks. Repeatable |
| `gas` | string | How the run's gas was paid: `sponsored`, `wallet` or `free`. Repeatable. Any other value is dropped rather than refused, so `?gas=8453` returns the unfiltered list with no error: filter by chain with `network` above |
| `durationMin` | number | Only runs at or above this duration, in milliseconds |
| `durationMax` | number | Only runs strictly below this duration, in milliseconds. The bound is exclusive: a run of exactly this duration is not returned |
| `search` | string | Match on the run id and the workflow name for workflow runs, and the run id, type and network for direct runs. No column holding an error message is searched, so searching an error string returns an empty page. Truncated to 128 characters |
| `limit` | number | Results per page (default: 50, capped at 100: a larger value is clamped rather than rejected) |
| `cursor` | string | Pagination cursor from previous response |
| `page` | number | One-based page number, an alternative to `cursor`. Values below 1 are clamped to 1 |
| `projectId` | string | Restrict the listing to one workflow project. Direct executions are excluded rather than filtered |

### Response

```json
{
  "runs": [
    {
      "id": "hjsuassmcb19zvfpzi38r",
      "source": "workflow",
      "status": "success",
      "startedAt": "2024-01-01T00:00:00Z",
      "completedAt": "2024-01-01T00:00:05Z",
      "durationMs": 5000,
      "workflowId": "y3y0xneior3njl90uoyih",
      "workflowName": "Monitor ETH Balance",
      "directType": null,
      "network": "8453",
      "networks": ["8453"],
      "gasNetworks": ["8453"],
      "gasCostWei": "21000000000000",
      "gasUsedWei": "21000000000000",
      "transactionHashes": [
        {
          "hash": "0x...",
          "nodeId": "n1",
          "nodeName": "Write Contract",
          "verified": true,
          "receiptStatus": "success",
          "blockNumber": 19000000,
          "gasUsed": "21000000000000",
          "verifiedAt": "2024-01-01T00:00:06Z"
        }
      ],
      "totalSteps": 3,
      "completedSteps": 3,
      "error": null,
      "errorCode": null,
      "errorType": null,
      "errorCategory": null
    }
  ],
  "nextCursor": null,
  "total": 1250,
  "page": 1,
  "pageSize": 50,
  "stepLogRetentionCutoff": "2024-01-01T00:00:00Z"
}
```

`startedAt`, not `createdAt`: a run is dated from when it started, and a run that
has not finished carries `completedAt: null` and `durationMs: null`. `directType`
is set on direct executions and `null` on workflow runs, where `source`,
`workflowId` and `workflowName` carry the identity instead. It is not an enum and
not exhaustive: `transfer`, `contract-call` and `check-and-execute` are the values
the direct-execution routes write (hyphenated, so `contract_call` never matches),
`protocol-action` comes from the protocol runner, and a node execution writes the
resolved action id it ran, which is any system action (`Database Query`,
`HTTP Request`, `Condition`) or any plugin action id. A caller switching on it
exhaustively falls through on every protocol and node execution.

`transactionHashes` is an array on both sources, one entry per on-chain write in
submission order, with a direct execution surfacing its single hash as a
one-element array so both render through the same code. Every entry carries
`hash`, `nodeId` and `nodeName`, which are the first three fields in the example
above; everything below them is optional. `chainId`, `network` and
`iterationIndex` are omitted rather than set to `null` when the log row had no
value for them, so test for their presence rather than comparing against `null`.

On a workflow entry, the receipt verification KeeperHub performs independently
(`verified`, `receiptStatus`, `blockNumber`, `gasUsed`, `verifiedAt`) is the part a
caller cannot reconstruct from the chain alone, and it is present only where it
ran at finalize: an entry whose hash matched no verification result is returned
untouched, and a run that failed inspects only the writes still in flight. A
missing `verified` on a workflow entry therefore means not verified in this
response, never verification failed.

A direct run's entry carries none of those five fields. It is synthesised from
the execution's single `transaction_hash`, with `nodeId: "direct"` and
`nodeName: "Direct execution"` as sentinels rather than real identifiers, plus
`network` when the execution recorded one. Discriminate on `source === "direct"`
rather than on the sentinel strings. The verification the direct execution
recorded lives in that execution's own receipts, which this endpoint does not
read.

An empty array means the run produced no on-chain write, or finalized before the
column was backfilled.

`networks` is every chain the run's steps targeted, including read-only steps;
`gasNetworks` is the subset its gas landed on. A multi-chain run can therefore
have a longer `networks` than `gasNetworks`, which is why `network` and the gas
figures are only meaningful together when that list holds one entry.

`stepLogRetentionCutoff` is present on every response, `null` when nothing has
aged out, and otherwise the instant a run must be older than to have no steps
behind it: such a run is listed with its status and duration and no steps, rather
than being blank for the same reason a run that recorded nothing is. It is marked
optional in the response type, but the route serializes the object as it stands,
so the key ships either way and a caller testing for its presence takes the
retention path for every organization.

## Get Run Step Logs

```http
GET /api/analytics/runs/{executionId}/steps
```

Returns the step log for one execution, in the order the steps ran.

### Response

A bare array, with no envelope:

```json
[
  {
    "id": "st_hjsuassmcb19zvfpzi",
    "nodeId": "node_1",
    "nodeName": "Trigger",
    "nodeType": "trigger/manual",
    "status": "success",
    "startedAt": "2024-01-01T00:00:00Z",
    "completedAt": "2024-01-01T00:00:00.120Z",
    "durationMs": 120,
    "error": null,
    "iterationIndex": null,
    "forEachNodeId": null,
    "network": null,
    "gasCostWei": null,
    "sponsored": false
  }
]
```

A step's input and output are not part of this response: the log carries what the
run did (`nodeName`, `nodeType`, `status`, timings, `error`) and the on-chain
detail where there was a write (`network`, `gasCostWei`, `sponsored`). Read a
step's own data from the execution's stored output if you need it.

`iterationIndex` and `forEachNodeId` are set on steps inside a For Each body, and
`null` elsewhere. An empty array is the expected answer for a run whose step logs
retention has taken, which the runs listing reports through
`stepLogRetentionCutoff`.

Step logs are workflow-only: the query joins `workflow_executions` and `workflows`,
so a direct run id, which List Runs returns alongside workflow ids, gives an empty
array and a `200`, exactly as an unknown id does. Retention is not the only
explanation for an empty array, and it is the wrong one to reach for when the id
came from a direct row.

## Get Spend Cap Data

```http
GET /api/analytics/spend-cap
```

Returns current spending status against the daily spending caps.

`dailyCapWei` and `dailySolanaCapLamports` report what the organization configured, and are `null` when it configured nothing. That is not the same as being uncapped: the `effective*` fields carry the figure enforcement actually applies, which is the platform default whenever `usingDefault*` is true. Plan against the effective figures.

### Response

```json
{
  "dailyCapWei": null,
  "dailyUsedWei": "25000000000000000",
  "dailySolanaCapLamports": null,
  "dailySolanaUsedLamports": "0",
  "effectiveDailyCapWei": "20000000000000000",
  "effectiveDailySolanaCapLamports": "500000000",
  "usingDefaultDailyCap": true,
  "usingDefaultDailySolanaCap": true
}
```

## Stream Analytics (SSE)

```http
GET /api/analytics/stream
```

Server-Sent Events endpoint for real-time analytics updates.

### Query Parameters

Same as summary endpoint.

### Event Format

```
data: {"type":"summary","data":{...}}

data: {"type":"summary","data":{...}}
```

The stream sends updated summary data when changes are detected, polling every 5 seconds, with automatic reconnection and heartbeat support. A heartbeat follows every 30 seconds, events are coalesced to at most one per second, and every stream is closed after 5 minutes, which is what the reconnection is for.
