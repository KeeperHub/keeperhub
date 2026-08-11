---
title: "Workflows API"
description: "KeeperHub Workflows API - create, read, update, delete, and execute workflows."
---

# Workflows API

Manage workflows programmatically.

## List Workflows

```http
GET /api/workflows
```

Returns all workflows for the authenticated user (session) or organization (API key).

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | Optional. Filter workflows by project ID |
| `tagId` | string | Optional. Filter workflows by tag ID |

### Example

```http
GET /api/workflows?projectId=proj_123&tagId=tag_456
```

### Response

```json
[
  {
    "id": "wf_123",
    "name": "My Workflow",
    "description": "Monitors ETH balance",
    "visibility": "private",
    "nodes": [],
    "edges": [],
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
]
```

## Get Workflow

```http
GET /api/workflows/{workflowId}
```

Returns a single workflow by ID.

### Response

```json
{
  "id": "wf_123",
  "name": "My Workflow",
  "description": "Monitors ETH balance",
  "visibility": "private",
  "nodes": [...],
  "edges": [...],
  "publicTags": [
    {
      "id": "tag_1",
      "name": "DeFi",
      "slug": "defi"
    }
  ],
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "isOwner": true
}
```

Public workflows include a `publicTags` array showing all assigned tags.

## Create Workflow

```http
POST /api/workflows/create
```

### Request Body

```json
{
  "name": "New Workflow",
  "description": "Optional description",
  "projectId": "proj_123",
  "nodes": [
    {
      "id": "trigger",
      "type": "trigger",
      "data": {
        "label": "Schedule Trigger",
        "config": { "triggerType": "Schedule", "scheduleCron": "*/30 * * * *" }
      }
    },
    {
      "id": "supply-aave",
      "type": "action",
      "data": {
        "label": "Supply USDC to Aave",
        "config": {
          "actionType": "aave-v3/supply",
          "network": "8453",
          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "amount": "100000000",
          "onBehalfOf": "0x0000000000000000000000000000000000000000"
        }
      }
    }
  ],
  "edges": [
    {
      "id": "trigger->supply-aave",
      "source": "trigger",
      "target": "supply-aave"
    }
  ]
}
```

> **Note on Node Format:** For action nodes, set the outer `type` to `"action"` and place the plugin slug in `config.actionType`. The `data` object contains `label` and `config`; `status` and `position` are optional and auto-assigned by the API if omitted. Trigger nodes use outer `type: "trigger"` with `config.triggerType` set to the Pascal-case trigger name.
>
> The server normalizes the request before persisting it, so the saved node will also include an inner `data.type` field set to the kind discriminator (`"trigger"` or `"action"`). You do not need to send `data.type` yourself; if you do, it must match the outer `type`. As a convenience, sending the plugin slug at the outer `type` (for example `"type": "aave-v3/supply"`) is also accepted, and the server rewrites it into `config.actionType` during normalization.

`name`, `nodes`, and `edges` are required. `description`, `projectId`, `tagId`, and `enabled` are optional. `projectId` assigns the workflow to a [project](/api/projects); `tagId` assigns it to an organization tag for categorization; `enabled` (boolean) controls whether the workflow is active on creation.

### Generic web3 write-contract example (Manual trigger)

Named-protocol actions (`aave-v3/supply`, etc.) hide most of the plumbing behind protocol-aware config keys. When you want to call an arbitrary contract that isn't in the [plugin catalog](/plugins/web3), use the generic `web3/write-contract` action. The trap is that the UI labels ("Function", "Function Arguments") don't line up 1:1 with the API field names, and `functionArgs` is a **JSON-encoded array string**, not a raw array. The full config shape:

```json
{
  "name": "Release escrow on Sepolia",
  "nodes": [
    {
      "id": "trigger-1",
      "type": "trigger",
      "data": {
        "label": "Manual",
        "config": { "triggerType": "Manual" }
      }
    },
    {
      "id": "step-1",
      "type": "action",
      "data": {
        "label": "Release Escrow",
        "config": {
          "actionType": "web3/write-contract",
          "network": "11155111",
          "web3Connection": "default",
          "contractAddress": "0x599869cef2e4c52e2c9074caaf8f9fb0cb191776",
          "abi": "[{\"type\":\"function\",\"name\":\"release\",\"stateMutability\":\"nonpayable\",\"inputs\":[{\"name\":\"depositId\",\"type\":\"bytes32\"}],\"outputs\":[]}]",
          "abiFunction": "release",
          "functionArgs": "[\"{{@trigger-1:Manual.depositId}}\"]"
        }
      }
    }
  ],
  "edges": [
    { "id": "e", "source": "trigger-1", "target": "step-1" }
  ]
}
```

Field-name gotchas the strict validator will reject:

| UI label | API field name | Notes |
|---|---|---|
| Function | `abiFunction` | Not `function`, `method`, or `functionName`. See the note below on `functionName`. |
| Function Arguments | `functionArgs` | A JSON-encoded array **string** (`"[\"0x…\"]"`), not a raw array. Templates inside the string are resolved before `JSON.parse`. |
| Web3 Connection | `web3Connection` | Sender routing: `"default"` (org policy), `"eoa"` (force the Turnkey EOA), or `"safe:<safeWalletId>"`. The signing wallet is your org's Turnkey wallet, resolved automatically. |
| Contract ABI | `abi` | JSON-encoded string, not a raw array — same shape convention as `functionArgs`. |

A warning on `functionName` and `args`: the save-time validator accepts them, because workflows persisted before a field rename still carry that shape and have to stay re-savable. The runtime does not translate them. A workflow that uses `functionName` will therefore save without complaint and then fail at execution with ``Missing `abiFunction` in the step config``. Always send `abiFunction` and `functionArgs`.

Trigger data reference from a downstream action uses the [stored templating format](/workflows/templating): `{{@<nodeId>:<Label>.<field>}}`. Fields on the `input` object are spread into the trigger's output, so `{"input": {"depositId": "0x…"}}` sent to [`POST /api/workflows/{id}/execute`](#execute-workflow) is reachable at `{{@trigger-1:Manual.depositId}}`. Valid `triggerType` values are `Manual`, `Schedule`, `Webhook`, `Event`, `Block`, and `Transfer`; a `Webhook` trigger receives the same treatment on its own `POST /api/workflows/{id}/webhook` URL.

### Response

Returns the created workflow with a default trigger node and an empty action node connected to it.

## Update Workflow

```http
PATCH /api/workflows/{workflowId}
```

### Request Body

```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "projectId": "proj_123",
  "tagId": "tag_456",
  "nodes": [...],
  "edges": [...],
  "visibility": "private"
}
```

The `tagId` field assigns the workflow to an organization tag for categorization.

## Delete Workflow

```http
DELETE /api/workflows/{workflowId}
```

Returns `409 Conflict` if the workflow has execution history. Use the `force` query parameter to cascade delete all runs and logs:

```http
DELETE /api/workflows/{workflowId}?force=true
```

## Execute Workflow

```http
POST /api/workflows/{workflowId}/execute
```

Manually trigger a workflow execution. The singular form `POST /api/workflow/{workflowId}/execute` is also accepted for backward compatibility.

### Request Body

```json
{
  "input": { "key": "value" }
}
```

The `input` field is optional. It maps to the workflow's trigger input and is passed to the first node of the run.

### Example

```bash
curl -X POST https://app.keeperhub.com/api/workflows/wf_123/execute \
  -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": {}}'
```

### Response

```json
{
  "executionId": "exec_123",
  "status": "running"
}
```

## Webhook Trigger

```http
POST /api/workflows/{workflowId}/webhook
```

Trigger a workflow via webhook. Requires API key authentication.

## Duplicate Workflow

```http
POST /api/workflows/{workflowId}/duplicate
```

Creates a copy of an existing workflow.

## Download Workflow

```http
GET /api/workflows/{workflowId}/download
```

Download workflow definition as JSON.

## Generate Code

```http
GET /api/workflows/{workflowId}/code
```

Generate SDK code for the workflow.

## Claim Workflow

```http
POST /api/workflows/{workflowId}/claim
```

Claim an anonymous workflow into the authenticated user's organization. Only the original creator of the anonymous workflow can claim it.

## Publish Workflow (Go Live)

```http
PUT /api/workflows/{workflowId}/go-live
```

Publish a workflow to make it publicly visible with metadata and tags.

### Request Body

```json
{
  "name": "Public Workflow Name",
  "publicTagIds": ["tag_1", "tag_2"]
}
```

The `name` is required. `publicTagIds` is an array of public tag IDs to associate with the workflow (maximum 5 tags).

## List Public Workflows

```http
GET /api/workflows/public
```

Returns all public workflows with optional filtering.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `featured` | boolean | Optional. Filter for featured workflows (`?featured=true`) |
| `featuredProtocol` | string | Optional. Filter for protocol-featured workflows (e.g., `?featuredProtocol=sky`) |
| `tag` | string | Optional. Filter by public tag slug (e.g., "defi", "nft") |

### Response

```json
[
  {
    "id": "wf_123",
    "name": "Public Workflow",
    "description": "Description",
    "nodes": [...],
    "edges": [...],
    "publicTags": [
      {
        "id": "tag_1",
        "name": "DeFi",
        "slug": "defi"
      }
    ],
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
]
```

## Update Featured Status (Internal)

```http
POST /api/hub/featured
```

Mark a workflow as featured in the hub. Requires internal service authentication (`hub` service). Accepts optional `category`, `protocol`, and `featuredOrder` fields alongside the `workflowId`.

## List Action Schemas

```http
GET /api/mcp/schemas
```

Returns the complete registry of available workflow actions, triggers, and templates. Essential for programmatic workflow generation to discover valid action configurations.

### Response Structure

```json
{
  "version": "1.0.0",
  "actions": {
    "web3/check-balance": {
      "actionType": "web3/check-balance",
      "label": "Check Balance",
      "category": "web3",
      "integration": "web3",
      "requiredFields": { "network": "string (chain ID)", "address": "string" },
      "optionalFields": {},
      "outputFields": { "balance": "..." },
      "requiresCredentials": false
    },
    "Condition": {
      "actionType": "Condition",
      "label": "Condition",
      "category": "System",
      "requiredFields": { "condition": "string (JS expression)" },
      "optionalFields": { "conditionConfig": "object (visual builder state)" },
      "sourceHandles": ["true", "false"]
    }
  },
  "triggers": {
    "Schedule": {
      "triggerType": "Schedule",
      "label": "Schedule",
      "requiredFields": { "scheduleCron": "string" },
      "optionalFields": { "scheduleTimezone": "string" }
    },
    "Manual": { "triggerType": "Manual", "label": "Manual", "requiredFields": {} }
  },
  "chains": [...],
  "platform": { "wallet": {...}, "proxyContracts": {...}, "abiHandling": {...} },
  "templateSyntax": { "pattern": "{{@nodeId:Label.field}}" },
  "builtinVariables": {
    "nodeId": "__system",
    "nodeLabel": "System",
    "variables": { "unixTimestamp": {...}, "unixTimestampMs": {...}, "isoTimestamp": {...} }
  },
  "workflowStructure": { "nodeStructure": {...}, "edgeStructure": {...} },
  "tips": ["actionType must match exactly", "..."]
}
```

> **Note on Action Types:** The keys in the `actions` object are the values to use in `config.actionType` when creating workflow nodes.
> - **Plugin actions** use a `{pluginType}/{slug}` format (e.g., `"web3/check-balance"`, `"aave-v3/supply"`).
> - **System actions** use Pascal-case with spaces between words (e.g., `"Condition"`, `"For Each"`, `"HTTP Request"`). System actions do not have a `requiresCredentials` field.
> - **Triggers** are listed under the `triggers` key (not `actions`) and their values map to `config.triggerType` on trigger nodes.
> - The endpoint self-documents the correct node and edge shapes under the `workflowStructure` and `edgeStructure` keys — use these as the source of truth for programmatic workflow generation.
