---
title: "Get Execution"
description: "The response shape of the get_execution MCP tool: the nested status/logs structure, which fields are numbers versus strings, and the order log entries arrive in."
---

# get_execution

`get_execution` returns combined status and step-by-step logs for a workflow execution in a single response: `{ status, logs }`. This page documents that response shape, which is not otherwise written down — the tool description covers arguments, not the two objects it hands back.

## Tool call

```json
{
  "tool": "get_execution",
  "arguments": {
    "executionId": "exec_abc123"
  }
}
```

### Arguments

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `executionId` | string | Yes | The execution ID returned by `execute_workflow`. |
| `includeData` | boolean | No (default `true`) | Omit the `input`/`output`/`outputRaw` blobs from each log entry. Every log entry is still returned, and `logs.execution` is unaffected — see [what `includeData: false` does not shrink](#what-includedata-false-does-not-shrink). |
| `nodeIds` | string[] | No | Restrict full input/output/outputRaw data to these node IDs (exact, case-sensitive). Other entries still return every field except those three blobs: `id`, `executionId`, `nodeId`, `nodeName`, `nodeType`, `status`, `error`, `startedAt`, `completedAt`, `duration`, `timestamp`, `iterationIndex`, `forEachNodeId`, `network`, `gasUsedWei`. Has no effect when `includeData` is `false`. |
| `truncateData` | positive integer | No | Per-field byte cap. Any oversized `input`/`output`/`outputRaw` payload is replaced with `{ _truncated: true, originalSize, preview }`. `error` is never truncated. Non-integer or non-positive values are rejected by the tool's argument schema. |

## Response shape

```json
{
  "status": {
    "status": "success",
    "nodeStatuses": [
      { "nodeId": "trigger", "status": "success" },
      { "nodeId": "transfer-1", "status": "success" }
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
        "nodeId": "transfer-1",
        "nodeName": "Transfer",
        "chainId": 1,
        "network": "mainnet",
        "verified": true,
        "receiptStatus": "success"
      }
    ]
  },
  "logs": {
    "execution": {
      "id": "exec_abc123",
      "workflowId": "wf_456",
      "status": "success",
      "totalSteps": "2",
      "completedSteps": "2",
      "duration": "1834",
      "input": { "...": "the run's own input blob" },
      "output": { "...": "the run's own output blob" },
      "transactionHashes": [ "... same shape as status.transactionHashes ..." ],
      "workflow": { "nodes": [ "..." ], "edges": [ "..." ], "...": "the full workflow row" },
      "...": "every other workflow_executions column"
    },
    "logs": [
      { "nodeId": "transfer-1", "nodeName": "Transfer", "status": "success", "startedAt": "...", "duration": "812", "...": "..." },
      { "nodeId": "trigger", "nodeName": "Manual Trigger", "status": "success", "startedAt": "...", "duration": "41", "...": "..." }
    ]
  }
}
```

`status` and `logs` are two independent HTTP reads of the same execution, issued concurrently and merged by the tool — not one derived from the other, and not one table each (both endpoints read the executions row and the step-log rows). Several things fall out of that worth knowing before you write a decoder:

### `totalSteps` and `completedSteps` are numbers in `status.progress`, strings or `null` in `logs.execution`

`status.progress.totalSteps` / `completedSteps` are parsed to real numbers before being returned. The same fields on `logs.execution` are not — they come straight off the `workflow_executions` row, where `total_steps` and `completed_steps` are `text` columns. So `status.progress.completedSteps === 2` (number) and `logs.execution.completedSteps === "2"` (string) describe the same run.

They are not merely differently typed, they differ before a run is dispatched. `total_steps` has no column default, so `logs.execution.totalSteps` is `null` until the executor initializes progress; `completed_steps` defaults to `"0"`. `status.progress` coerces both (`parseInt(value || "0")`), so it reports `0` where `logs.execution` reports `null`. `parseInt(logs.execution.totalSteps, 10)` on a `pending` execution yields `NaN`.

Because the two objects are fetched concurrently rather than from one snapshot, `status.progress.completedSteps` and `logs.execution.completedSteps` can also legitimately disagree by a step on a run that is still executing. That is a race between two reads, not a data-integrity problem. Read progress from `status.progress`.

### `duration` is a string in both places, and exists per step as well as per run

`duration` has no equivalent on `status.progress`, but it is not a single field: `logs.execution.duration` is the run total and each entry in `logs.logs` carries its own `duration` for that step. Both are Postgres `numeric` columns, which serialize as strings to avoid precision loss. Per-step durations survive `nodeIds` filtering, so you can get step timings without requesting any input/output data.

### `logs.logs` arrives newest-first, not in execution order

The per-node entries in `logs.logs` are ordered by `timestamp` descending — the most recently completed node first. That is reverse-chronological, not the order the workflow actually ran in. If you need execution order:

- Sort `logs.logs` by `startedAt` ascending yourself, or
- Read `logs.execution.executionTrace`, an array of node IDs in the order the executor actually ran them.

`executionTrace` is set to `[]` when the executor initializes progress, which happens *before* the first step runs; each completed step then appends to it. So an execution that has started but completed no steps reads `[]`, not `null`. `null` means progress was never initialized — the run has not been dispatched, or failed before the executor picked it up. It is the same condition under which `totalSteps` is `null`: both fields are written by the same initializing update. Branch on `Array.isArray(trace) && trace.length === 0` for "started, nothing finished"; a bare falsy check treats the empty array as not-started.

`status.errorContext.executionTrace` carries the same array, but only when the run ended in `error` or `system_error`, and only on an execution your organization owns (see [Cross-organization executions](#cross-organization-executions)).

### `errorContext` is `null` on every non-error status

`status.errorContext` is populated only when `status.status` is `"error"` or `"system_error"`. Every other status gets `null` — not omitted, `null`. That currently means `pending`, `running`, `unconfirmed`, `success`, `cancelled`, and `phantom`, but treat the rule ("null unless the status is one of the two error statuses") as the contract rather than that list: as [Status Values](/api/executions#status-values) notes, the status set is a lower bound and a client that switches on a closed set will mishandle statuses added after it shipped.

### `transactionHashes` is an array of receipt objects, not hash strings

Both `status.transactionHashes` and `logs.execution.transactionHashes` are arrays of receipt objects (`hash`, `nodeId`, `nodeName`, `verified`, `receiptStatus`, ...), not plain strings. See [Transaction Hashes](/api/executions#transaction-hashes) for the full field table. On the cross-organization path most of those fields are stripped; see below.

### What `includeData: false` does not shrink

`includeData: false` omits `input`, `output` and `outputRaw` from each entry in `logs.logs`. It does not reduce the response to status alone:

- Every log row is still returned, with all of its other columns.
- `logs.execution` keeps the execution's own `input` and `output` JSONB unmodified.
- `logs.execution.workflow` is the full workflow row, including the `nodes` and `edges` JSONB. On a large graph this is often the biggest object in the response, and none of `includeData`, `nodeIds` or `truncateData` touch it.

If you are sizing a context budget, budget for the workflow definition and the run-level blobs regardless of these arguments.

## Cross-organization executions

For an execution you can see only through its workflow's public share setting (not one your organization owns), the shape changes:

```json
{
  "status": { "...": "same shape, heavily redacted - see the table below" },
  "logs": null,
  "note": "This execution belongs to another organization and is visible only through its workflow's public share setting. Step logs are withheld and the status is redacted (node identifiers omitted); includeData, nodeIds and truncateData do not apply."
}
```

`logs` is `null` rather than an empty object — a client that only checks `logs.logs` without checking `logs` itself first will throw here.

The `note`'s "node identifiers omitted" understates what is removed. The redaction is an allowlist, and it strips fields this page documents as present on the owned path:

| Field | Cross-organization value |
|-------|--------------------------|
| `nodeStatuses[].nodeId` | `""` — blanked, not removed, so `'nodeId' in node` is still `true` |
| `nodeStatuses[].status` | unchanged |
| `progress.currentNodeId` / `currentNodeName` | `null` |
| `progress.*Steps` / `percentage` | unchanged |
| `errorContext` | rebuilt as `{ failedNodeId: null, lastSuccessfulNodeId: null, lastSuccessfulNodeName: null }` — `executionTrace` and `error` are absent entirely |
| `transactionHashes[]` | rebuilt from `hash` and `chainId` only, plus `nodeId: ""` and `nodeName: ""`. `verified`, `receiptStatus`, `network`, `blockNumber`, `gasUsed`, `verifiedAt` and `iterationIndex` are absent |

The two removals that bite hardest: `transactionHashes[].verified` is `undefined` here, so a client gating on `verified === true` reads a successfully verified run as unverified; and `errorContext.executionTrace` is gone, so the trace is unavailable from either object on this path.

## Deprecated aliases

`get_execution_status` and `get_execution_logs` return the `status` and `logs` objects above individually, not the combined response. Both are deprecated **now**; their registered descriptions read "will be removed in v1.13", so v1.13 is the removal release, not the start of the deprecation.

Their field shapes match, but their access behavior does not. Only `get_execution` handles the public-share case; both aliases fetch the logs endpoint, which is owner-only:

| Tool | Execution your org owns | Cross-organization public-share execution |
|------|-------------------------|-------------------------------------------|
| `get_execution` | `{ status, logs }` | `{ status: <redacted>, logs: null, note }` |
| `get_execution_status` | `{ status }` | throws `API call failed: 404 Not Found` |
| `get_execution_logs` | `{ logs }` | throws `API call failed: 404 Not Found` |

`get_execution_status` fails even though the status endpoint alone would have served a redacted payload: it fetches status and logs together and the logs request rejects. Migrate to `get_execution` before pointing any of these at a shared execution.
