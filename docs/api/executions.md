---
title: "Executions API"
description: "KeeperHub Executions API - monitor workflow execution status and retrieve logs."
---

# Executions API

Monitor and manage workflow executions.

## List Executions

```http
GET /api/workflows/{workflowId}/executions
```

Returns execution history for a workflow.

### Response

```json
[
  {
    "id": "exec_123",
    "workflowId": "wf_456",
    "status": "success",
    "input": {...},
    "output": {...},
    "startedAt": "2024-01-01T00:00:00Z",
    "completedAt": "2024-01-01T00:00:05Z",
    "transactionHashes": [
      {
        "hash": "0x111...",
        "nodeId": "approve-token-1",
        "nodeName": "Approve USDC",
        "chainId": 1,
        "network": "mainnet"
      }
    ]
  }
]
```

## Get Execution Status

```http
GET /api/workflows/executions/{executionId}/status
```

Returns real-time execution status with progress tracking.

### Response

```json
{
  "status": "success",
  "nodeStatuses": [
    { "nodeId": "node_1", "status": "success" },
    { "nodeId": "node_2", "status": "success" }
  ],
  "progress": {
    "totalSteps": 2,
    "completedSteps": 2,
    "runningSteps": 0,
    "currentNodeId": null,
    "currentNodeName": null,
    "percentage": 100
  },
  "errorContext": null,
  "transactionHashes": [
    {
      "hash": "0x111...",
      "nodeId": "approve-token-1",
      "nodeName": "Approve USDC",
      "chainId": 1,
      "network": "mainnet"
    },
    {
      "hash": "0x222...",
      "nodeId": "write-contract-1",
      "nodeName": "Swap on Uniswap",
      "chainId": 1,
      "network": "mainnet"
    }
  ]
}
```

### Status Values

| Status | Description | Terminal |
|--------|-------------|----------|
| `pending` | Execution queued | no |
| `running` | Currently executing | no |
| `unconfirmed` | On-chain writes were submitted but their receipts could not be read conclusively. Keep polling | **no** |
| `success` | Completed successfully | yes |
| `error` | Failed with error | yes |
| `system_error` | Failed for an infrastructure reason, or was reaped after going stale | yes |
| `cancelled` | Manually cancelled | yes |

Treat this list as a lower bound rather than a closed set, and decide terminality from the `X-Poll-Interval-Hint` response header rather than from the status string. The server computes that header from its own terminal set, so it stays correct for statuses added after your client shipped; `0` means terminal. A client that routes an unrecognised status into a failing `default` branch reports a failure for a run that is still settling.

### Transaction Hashes

`transactionHashes` is the full ordered list of on-chain writes recorded by the workflow, in submission order. Single-tx workflows have a one-element array; multi-tx workflows (approve+swap, fan-out transfers, For-Each loops) have N elements. Each entry has:

| Field | Type | Description |
|-------|------|-------------|
| `hash` | string | 0x-prefixed transaction hash |
| `nodeId` | string | Workflow node identifier that produced the hash |
| `nodeName` | string | Human-readable label from the canvas |
| `chainId` | number (optional) | EIP-155 chain id, when emitted by the step |
| `network` | string (optional) | Network slug (e.g. `mainnet`, `arbitrum`) |
| `iterationIndex` | number (optional) | 0-based For-Each loop index; present only for entries produced inside a For-Each iteration |
| `verified` | boolean (optional) | Whether this hash positively confirmed on-chain. An execution settles as `success` only when every entry is `true` |
| `receiptStatus` | string (optional) | `success`, `reverted`, `safe_inner_failure`, `not_found`, or `timeout` |
| `blockNumber` | number (optional) | Block the transaction was mined in, read from the fetched receipt |
| `gasUsed` | string (optional) | Gas used, read from the fetched receipt |
| `verifiedAt` | string (optional) | ISO timestamp of the verification |

The verification fields are populated when the execution reaches a terminal state: every claimed hash is re-fetched from the chain before the run is allowed to settle as `success`. `not_found` and `timeout` mean verification could not reach a definitive answer within its budget, and fail the run closed rather than settling it optimistically — an execution that failed with `timeout` may describe a transaction that later lands.

Prefer these entries over per-step output when you need to know what actually happened. A step's own `transactionHash` in the logs endpoint below is self-reported at the moment the step ran, before any independent check; only the entries here carry `verified` and `receiptStatus`.

An empty array carries one of two meanings: the run produced no on-chain writes, or the execution row was finalized before this field began being populated. The two cases are not distinguished at the response level — if the distinction matters for a historical row, the underlying hashes are reconstructable from per-step logs via the endpoint below. For full per-step input, output, error, and timing detail, also use the logs endpoint below.

## Wait for Receipt

```http
GET /api/workflows/executions/{executionId}/wait?timeoutMs=30000
```

Blocks until the execution reaches a terminal state (`success`, `error`, or `cancelled`) or the timeout elapses, then returns the execution receipt including `transactionHashes`. This replaces the client-side `while (!terminal) { sleep + GET status }` polling loop.

`timeoutMs` is optional (default `25000`, max `60000`). If the execution is still running when the timeout elapses, the response returns with `completed: false` and the current status — re-call to keep waiting.

### Response

```json
{
  "executionId": "exec_123",
  "status": "success",
  "completed": true,
  "transactionHashes": [
    {
      "hash": "0x111...",
      "nodeId": "write-contract-1",
      "nodeName": "Swap on Uniswap",
      "chainId": 1,
      "network": "mainnet"
    }
  ],
  "output": {...},
  "error": null,
  "gasUsedWei": "21000",
  "completedAt": "2024-01-01T00:00:05Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | enum | `pending`, `running`, `success`, `error`, `cancelled` |
| `completed` | boolean | `true` once the execution reached a terminal state; `false` if the wait timed out while still running |
| `transactionHashes` | array | Ordered on-chain writes (same shape as the status endpoint) |
| `output` | object | Workflow output |
| `error` | string \| null | Error message when `status` is `error` |
| `gasUsedWei` | string \| null | Run-total gas in wei |
| `completedAt` | timestamp \| null | When the execution finished, null while running |

## Get Execution Logs

```http
GET /api/workflows/executions/{executionId}/logs
```

Returns detailed per-node logs for an execution along with the execution row itself. Use this when you need per-step input, output, error, gas usage, or other step-specific detail. For the common case of "what hashes did this run produce", read `transactionHashes` on the [status](#get-execution-status) or [list](#list-executions) responses instead — that field is denormalised from these logs and avoids parsing per-step output.

`logs` is ordered by `timestamp` descending (most recent first).

### Response

```json
{
  "execution": {
    "id": "exec_123",
    "workflowId": "wf_456",
    "userId": "user_789",
    "status": "success",
    "input": {...},
    "output": {...},
    "startedAt": "2024-01-01T00:00:00Z",
    "completedAt": "2024-01-01T00:00:05Z",
    "duration": "5000",
    "transactionHashes": [...]
  },
  "logs": [
    {
      "id": "log_001",
      "executionId": "exec_123",
      "nodeId": "transfer-1",
      "nodeName": "First transfer",
      "nodeType": "web3/transfer-funds",
      "status": "success",
      "input": {...},
      "output": {
        "success": true,
        "transactionHash": "0xca19a1...",
        "gasUsed": "2100000882000",
        "gasUsedUnits": "21000",
        "effectiveGasPrice": "100000042",
        "transactionLink": ""
      },
      "error": null,
      "duration": "1850",
      "startedAt": "2024-01-01T00:00:00Z",
      "completedAt": "2024-01-01T00:00:01Z",
      "iterationIndex": null,
      "forEachNodeId": null
    }
  ]
}
```

### Log entry fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Log row identifier |
| `executionId` | string | Parent execution |
| `nodeId` | string | Workflow node identifier (e.g. `transfer-1`) |
| `nodeName` | string | Human-readable label from the canvas |
| `nodeType` | string | Step type, e.g. `trigger`, `web3/transfer-funds`, `web3/write-contract`, `condition`, `code/run-code` |
| `status` | enum | `pending`, `running`, `success`, `error`, `cancelled` |
| `input` | object | Resolved step input (after template expansion). Sensitive fields are redacted |
| `output` | object | Step return value. Shape depends on `nodeType` — see below |
| `error` | string \| null | Error message if `status === "error"` |
| `duration` | string | Milliseconds the step ran for, as a numeric string |
| `startedAt` | timestamp | When the step started |
| `completedAt` | timestamp | When the step finished (null while running) |
| `iterationIndex` | number \| null | 0-based index when this log row was produced inside a For-Each iteration; `null` for top-level steps |
| `forEachNodeId` | string \| null | Parent For-Each node id when this is a loop iteration row; `null` otherwise |

### Output shapes by node type

`output` is the step function's return value, so the shape varies. Common conventions:

**Success envelope**: every step's output object includes `success: true` on the happy path, `success: false` with an `error: string` on failures. Step-specific data sits alongside.

**Trigger nodes** (`nodeType: "trigger"`):

```json
{
  "success": true,
  "data": { "triggered": true, "triggeredAt": "2024-01-01T00:00:00Z", "timestamp": 1704067200000 }
}
```

Event triggers additionally include `transactionLink` (block explorer URL for the event tx hash) and `addressLink` (block explorer URL for the event address) when available.

**Web3 write steps** (`web3/transfer-funds`, `web3/transfer-token`, `web3/approve-token`, `web3/write-contract`, sponsored variants):

```json
{
  "success": true,
  "transactionHash": "0x...",
  "gasUsed": "2100000882000",
  "gasUsedUnits": "21000",
  "effectiveGasPrice": "100000042",
  "transactionLink": ""
}
```

`gasUsed` is total gas cost in wei (units × price); `gasUsedUnits` is the gas units; `effectiveGasPrice` is wei per unit. `transactionLink` is a block-explorer URL when configured for the chain, otherwise empty.

**Web3 read steps** (`web3/check-balance`, `web3/check-token-balance`, `web3/check-allowance`, `web3/batch-read-contract`, etc.):

```json
{
  "success": true,
  "data": { /* read result, varies by step */ }
}
```

**Condition / control-flow** (`condition`, `for-each`, `code/run-code`, etc.):

```json
{
  "success": true,
  "data": { /* step result */ }
}
```

For-Each iterations produce one log row per iteration, each with its own `iterationIndex` (`0`, `1`, `2`, ...) and the parent For-Each node id in `forEachNodeId`.

**Errors**:

```json
{
  "success": false,
  "error": "Failed to initialize organization wallet: ..."
}
```

When `output.success === false`, the same message is mirrored to the top-level `error` field on the log row.

### Common consumption patterns

- **Show a run's tx hashes**: read `execution.transactionHashes` on this response, or just hit the [status](#get-execution-status) endpoint. Don't iterate `logs` for this.
- **Debug a failed run**: filter `logs` by `status: "error"`, then read `error` + `input` + `output`.
- **Gas analytics**: sum `output.gasUsed` across `nodeType` matching `web3/*` with `status: "success"`.
- **Per-iteration audit on a For-Each**: filter `logs` by `forEachNodeId === "<your-foreach-node-id>"` and sort by `iterationIndex`.

## Delete Executions

```http
DELETE /api/workflows/{workflowId}/executions
```

Bulk delete execution history for a workflow.
