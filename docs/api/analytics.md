---
title: "Analytics API"
description: "KeeperHub Analytics API - monitor workflow performance, gas usage, and execution trends."
---

# Analytics API

The Analytics API provides insights into workflow and direct execution performance, gas usage, and execution trends across your organization.

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

## Get Time Series Data

```http
GET /api/analytics/time-series
```

Returns time-bucketed run counts for charting execution volume over time.

### Query Parameters

Same as summary endpoint.

### Response

```json
{
  "buckets": [
    {
      "timestamp": "2024-01-01T00:00:00Z",
      "runCount": 42,
      "successCount": 40,
      "failedCount": 2
    }
  ]
}
```

## Get Network Breakdown

```http
GET /api/analytics/networks
```

Returns execution counts and gas usage grouped by blockchain network.

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
      "id": "exec_123",
      "source": "workflow",
      "workflowId": "wf_456",
      "workflowName": "Monitor ETH Balance",
      "status": "success",
      "createdAt": "2024-01-01T00:00:00Z",
      "completedAt": "2024-01-01T00:00:05Z",
      "durationMs": 5000
    },
    {
      "id": "direct_789",
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

Returns current spending status against configured daily spending caps.

### Response

```json
{
  "dailyCapWei": "100000000000000000",
  "spentTodayWei": "25000000000000000",
  "remainingWei": "75000000000000000",
  "percentUsed": 25.0
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
