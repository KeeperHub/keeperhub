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
| `range` | string | Time range: `24h`, `7d`, `30d`, `90d`, `custom` (default: `30d`) |
| `customStart` | string | ISO timestamp for custom range start |
| `customEnd` | string | ISO timestamp for custom range end |

### Response

```json
{
  "totalRuns": 1250,
  "successfulRuns": 1180,
  "failedRuns": 70,
  "successRate": 94.4,
  "totalGasUsedWei": "15000000000000000",
  "avgExecutionTimeMs": 2340
}
```

**Field Definitions**

| Field | Type | Description |
|-------|------|-------------|
| `totalRuns` | number | Combined count of workflow executions and direct executions |
| `successfulRuns` | number | Number of executions that completed successfully |
| `failedRuns` | number | Number of executions that failed |
| `successRate` | number | Percentage of successful executions (0-100) |
| `totalGasUsedWei` | string | Total gas consumed in wei across both workflow executions and direct executions |
| `avgExecutionTimeMs` | number | Average execution duration in milliseconds |

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

Same as summary endpoint.

### Response

```json
{
  "networks": [
    {
      "network": "ethereum",
      "runCount": 520,
      "gasUsedWei": "8000000000000000"
    },
    {
      "network": "base",
      "runCount": 380,
      "gasUsedWei": "2500000000000000"
    }
  ]
}
```

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
| `status` | string | Filter by status: `pending`, `running`, `success`, `error` |
| `source` | string | Filter by source: `workflow`, `direct` |
| `limit` | number | Results per page (default: 50) |
| `cursor` | string | Pagination cursor from previous response |

### Response

```json
{
  "runs": [
    {
      "id": "hjsuassmcb19zvfpzi38r",
      "source": "workflow",
      "workflowId": "y3y0xneior3njl90uoyih",
      "workflowName": "Monitor ETH Balance",
      "status": "success",
      "createdAt": "2024-01-01T00:00:00Z",
      "completedAt": "2024-01-01T00:00:05Z",
      "durationMs": 5000
    },
    {
      "id": "9k2x7mwqcp5zvt0hnj1ab",
      "source": "direct",
      "type": "transfer",
      "network": "ethereum",
      "status": "success",
      "transactionHash": "0x...",
      "gasUsedWei": "21000000000000",
      "createdAt": "2024-01-01T00:01:00Z",
      "completedAt": "2024-01-01T00:01:15Z"
    }
  ],
  "nextCursor": "cursor_abc123"
}
```

## Get Run Step Logs

```http
GET /api/analytics/runs/{executionId}/steps
```

Returns detailed step-by-step logs for a specific execution.

### Response

```json
{
  "steps": [
    {
      "nodeId": "node_1",
      "nodeName": "Trigger",
      "status": "success",
      "input": {...},
      "output": {...},
      "durationMs": 120,
      "timestamp": "2024-01-01T00:00:00Z"
    }
  ]
}
```

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

The stream sends updated summary data every 2 seconds when changes are detected, with automatic reconnection and heartbeat support.
