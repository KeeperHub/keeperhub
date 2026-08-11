---
title: "MCP Trigger Inputs"
description: "Reference for the four trigger input discriminants on per-workflow KeeperHub MCP tools: manual, schedule, webhook, and on-chain-event. Includes copy-pasteable JSON examples and a backward-compat note for legacy flat-bag callers."
---

# MCP Trigger Inputs

Every KeeperHub per-workflow MCP tool (registered under the workflow's listed slug) advertises a typed input schema based on the workflow's trigger. Use the JSON shape that matches the workflow's trigger type. Your MCP client reads the schema directly from the tool definition and your agent fills it in.

## Discriminant overview

The discriminant field is named `type` and takes one of four string values:

| `type` value | When to use it |
|---|---|
| `"manual"` | Workflows that fire manually via UI or API — no caller input required |
| `"schedule"` | Workflows that fire on a cron schedule — cron is workflow-level config |
| `"webhook"` | Workflows that fire when a webhook URL receives a request |
| `"on-chain-event"` | Workflows that fire on a smart-contract event or at a block interval |

The discriminant value is a string literal. Use kebab-case for `on-chain-event` — underscore or camelCase variants do not match.

## Manual trigger

A manual-trigger workflow does not need any caller input. Send an empty payload or just the discriminant:

```json
{ "type": "manual" }
```

## Schedule trigger

A scheduled workflow runs on a cron expression configured in the workflow itself. No caller input is required — the discriminant is the entire payload:

```json
{ "type": "schedule" }
```

## Webhook trigger

A webhook-trigger workflow expects the same shape that a real webhook delivery would carry. All four fields are optional; include the ones your workflow consumes:

```json
{
  "type": "webhook",
  "method": "POST",
  "query": { "source": "agent" },
  "body": { "message": "hello" },
  "headers": { "x-source": "demo" }
}
```

Field shapes:

- `method` — HTTP method as a string (`"GET"`, `"POST"`, etc.). Optional.
- `query` — a flat string-to-string map of query parameters. Optional.
- `body` — the request body. Any JSON shape; the workflow defines what it consumes. Optional.
- `headers` — a flat string-to-string map of HTTP headers. Optional.

## On-chain event trigger

A workflow that fires on a smart-contract event takes the same fields the on-chain event tracker emits at runtime. `chainId` is required; the other fields are optional and depend on whether the workflow consumes them:

```json
{
  "type": "on-chain-event",
  "chainId": 1,
  "eventName": "Transfer",
  "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "blockNumber": 19500000
}
```

Field shapes:

- `chainId` — EVM chain ID as a number (`1` for Ethereum mainnet, `8453` for Base, `11155111` for Sepolia). Required.
- `eventName` — the event name as emitted on-chain (`"Transfer"`, `"Approval"`, etc.). Optional.
- `address` — the 0x-prefixed Ethereum address of the contract that emitted the event. Optional.
- `blockNumber` — the block number at which the event was emitted, as a non-negative integer. Optional.

The field names are `eventName` and `address`. These match the runtime payload that the on-chain event tracker emits and the names that downstream workflow nodes reference via `{{@trigger:Trigger.eventName}}` and `{{@trigger:Trigger.address}}` template expressions. Sending `event` or `contract` instead will not work — those fields are silently dropped at the schema boundary.

Block-interval triggers share the `"on-chain-event"` discriminant. Supply `chainId` (required) and `blockNumber` (optional) and omit `eventName` and `address`.

## Backward compatibility

Legacy callers that omit the `type` discriminant continue to work for manual-trigger workflows. The MCP server normalizes payloads without a `type` field to `{ "type": "manual" }` before validating. Any extra fields you include are silently dropped by the manual schema:

```json
{ "anyOldField": "anyOldValue" }
```

is treated as:

```json
{ "type": "manual" }
```

For non-manual triggers (`"schedule"`, `"webhook"`, `"on-chain-event"`) you must supply the discriminant — the schema only accepts the exact discriminant for the workflow's trigger type, so an event-trigger workflow called with a flat-bag payload returns a validation error pointing at the missing `type` field.

## Reading the schema from the tool

Your MCP client receives the discriminated input schema directly from each per-workflow tool's `inputSchema` at session-init time. An agent that lists the available tools sees the field requirements, types, and optional/required markers per discriminant. This page is for human developers writing integrations and for one-shot debugging — at runtime, the schema is the canonical contract.

## See also

- [MCP Server](/agent/mcp-server) — overview of the KeeperHub MCP server, authentication, and the full tool list
- [Agentic Wallets](/agent/agentic-wallet) — installing an x402/MPP wallet so your agent can call paid workflows
