---
title: "Test Workflow"
description: "Use the prepare_test_pin_data MCP tool to retrieve per-node pin schemas before supplying test inputs to a workflow."
---

# prepare_test_pin_data

`prepare_test_pin_data` returns the JSON Schema that each node in a workflow expects as pin data. Use it to discover exactly which fields each step needs before you supply test inputs — without executing any plugin, writing to the database, or making any network calls beyond fetching the workflow row.

The tool is read-only. It reads the plugin registry to derive schemas, so it returns results instantly regardless of workflow size.

## When to use

- **Before a test run** to know which fields each node expects, so you can supply realistic values instead of guessing.
- **Inside a generation loop** to inspect the shape of a newly created or modified workflow's steps before triggering execution.
- **For documentation and auditing** to enumerate all configurable fields across a workflow's nodes without opening the visual editor.

## Tool call

```json
{
  "tool": "prepare_test_pin_data",
  "arguments": {
    "workflowId": "wf_abc123"
  }
}
```

### Arguments

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `workflowId` | string | Yes | The ID of the workflow to introspect. Must belong to the caller's organization. |

## Return shape

The response always wraps the result in `{ ok: true, result: { nodes: [...] } }`.

Each entry in `nodes` describes one node from the workflow:

| Field | Type | Description |
|-------|------|-------------|
| `nodeId` | string | The node's ID as stored in the workflow. |
| `nodeName` | string | The node's display label, or its ID when no label is set. |
| `type` | string | The node's structural type — typically `"action"` or `"trigger"`. |
| `pinSchema` | object | A JSON Schema (`type: "object"`) describing the fields the plugin action accepts as pin data. |
| `required` | boolean | `true` when the action declares at least one required field in `pinSchema`. |

### pinSchema structure

Each `pinSchema` is a JSON Schema object:

```json
{
  "type": "object",
  "properties": {
    "fieldName": {
      "type": "string | number | boolean",
      "description": "...",
      "enum": ["option-a", "option-b"]
    }
  },
  "required": ["fieldName"],
  "additionalProperties": false
}
```

- `properties` maps field keys to their type, optional description, and optional enum values for select fields.
- `required` lists the keys that must be present in a valid pin payload.
- `additionalProperties: false` for known actions; `additionalProperties: true` for unknown action types (indicating the registry has no schema for that step).

## Example

### Request

```json
{
  "tool": "prepare_test_pin_data",
  "arguments": {
    "workflowId": "wf_abc123"
  }
}
```

### Response

```json
{
  "ok": true,
  "result": {
    "nodes": [
      {
        "nodeId": "trigger-1",
        "nodeName": "Manual Trigger",
        "type": "trigger",
        "pinSchema": {
          "type": "object",
          "properties": {},
          "required": [],
          "additionalProperties": true
        },
        "required": false
      },
      {
        "nodeId": "check-balance",
        "nodeName": "Check Balance",
        "type": "action",
        "pinSchema": {
          "type": "object",
          "properties": {
            "network": {
              "type": "string",
              "description": "Chain ID (e.g. 1 for Ethereum, 8453 for Base)"
            },
            "address": {
              "type": "string",
              "description": "Wallet address to check"
            }
          },
          "required": ["network", "address"],
          "additionalProperties": false
        },
        "required": true
      },
      {
        "nodeId": "send-alert",
        "nodeName": "Send Discord Message",
        "type": "action",
        "pinSchema": {
          "type": "object",
          "properties": {
            "webhookUrl": {
              "type": "string",
              "description": "Discord webhook URL"
            },
            "message": {
              "type": "string",
              "description": "Message content"
            },
            "username": {
              "type": "string",
              "description": "Display name for the bot"
            }
          },
          "required": ["webhookUrl", "message"],
          "additionalProperties": false
        },
        "required": true
      }
    ]
  }
}
```

### Unknown action type

If a node's action type is not in the plugin registry, the tool returns a fallback schema with `additionalProperties: true` and empty `properties` and `required` arrays. The `required` flag on the node is `false`. This is safe — it means the registry has no field definitions for that step, not that the step is broken.

```json
{
  "nodeId": "legacy-step",
  "nodeName": "Legacy Step",
  "type": "action",
  "pinSchema": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": true
  },
  "required": false
}
```

## Error responses

| HTTP status | `ok` | `error` | Meaning |
|-------------|------|---------|---------|
| 401 | `false` | `"Unauthorized"` | No valid bearer token or session cookie. |
| 403 | `false` | `"FORBIDDEN"` | The workflow exists but belongs to a different organization. |
| 404 | `false` | `"NOT_FOUND"` | No workflow with that ID. |
| 410 | `false` | `"GONE"` | The workflow has been soft-deleted. |

## Roadmap

Workflow dry-run execution support is on the roadmap. When available, it will accept the pin schemas returned by this tool to simulate step execution without triggering live on-chain transactions or external API calls.
