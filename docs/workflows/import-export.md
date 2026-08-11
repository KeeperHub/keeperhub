---
title: "Import/Export"
description: "Move workflows between accounts, share them, and version-control them as JSON."
---

# Import/Export

Workflows are JSON under the hood. KeeperHub lets you export a workflow you've built, edit or share the JSON outside the app, and import it back in (or into a different account). The same format is what the [Hub](/workflows/hub) uses when you duplicate a community template.

Good reasons to use export:

- **Move workflows between accounts.** Build in your dev org, ship to your prod org.
- **Version-control your automations.** Commit the JSON to git, review changes in PRs.
- **Share off-marketplace.** Send a colleague the JSON file directly.
- **Back up before risky edits.** Export, then go wild in the editor knowing you can revert.

## Exporting

Open a workflow, then click the **Download** icon in the top toolbar. The browser saves a `<workflow-slug>.workflow.json` file you can commit, mail, or pass to another KeeperHub user.

The export contains the workflow's name and description, every node and its config, every edge between them, and the integration-binding stubs (without your actual credentials). Run history and ownership are not exported.

## Importing

From the [Hub](/workflows/hub) or any workflow list view, click the **Upload** icon next to **New Workflow**, pick the JSON file, and KeeperHub creates a private copy in your account. The slug is auto-suffixed with `(Copy)` if the source name collides, and integration bindings are reset so you can attach your own connections before running.

## What's in the JSON

Every export has the same six top-level keys:

- `version`: schema version of the export format. Currently `1`.
- `exportedAt`: ISO 8601 timestamp of when the export was generated. Required, and validated as a datetime on import.
- `workflow`: the workflow's `name` and `description`.
- `nodes`: array of nodes. Each has `id`, `type`, `position` (canvas coordinates), and `data` (the per-node config).
- `edges`: array of edges connecting nodes by `id`. Conditional branches use `sourceHandle` set to `"true"` or `"false"`.
- `integrationBindings`: which connections (Discord, Slack, etc.) the workflow uses. Empty array if the workflow has no integration nodes.

## Examples

### Wallet balance alert with PagerDuty

A scheduled trigger checks an ETH balance every 10 minutes. If it falls below 1 ETH, a PagerDuty alert fires; otherwise the alert is auto-resolved. This is the canonical conditional pattern: trigger → action → condition → branched actions.

```json
{
  "version": 1,
  "exportedAt": "2026-04-28T01:13:20.004Z",
  "workflow": {
    "name": "Wallet balance below 1 ETH",
    "description": "Monitor a wallet's ETH balance. Triggers a PagerDuty alert when it drops below 1 ETH, resolves when balance is restored."
  },
  "nodes": [
    {
      "id": "trigger",
      "type": "trigger",
      "position": { "x": 100, "y": 250 },
      "data": {
        "type": "trigger",
        "label": "Every 10 Minutes",
        "config": {
          "triggerType": "Schedule",
          "scheduleCron": "*/10 * * * *"
        }
      }
    },
    {
      "id": "check-balance",
      "type": "action",
      "position": { "x": 350, "y": 250 },
      "data": {
        "type": "action",
        "label": "Check Balance",
        "config": {
          "actionType": "web3/check-balance",
          "network": "1",
          "address": "0x0000000000000000000000000000000000000000"
        }
      }
    },
    {
      "id": "condition-low",
      "type": "action",
      "position": { "x": 600, "y": 250 },
      "data": {
        "type": "action",
        "label": "Balance < 1 ETH",
        "config": {
          "actionType": "Condition",
          "condition": "{{@check-balance:Check Balance.balance}} < 1"
        }
      }
    },
    {
      "id": "pd-alert",
      "type": "action",
      "position": { "x": 850, "y": 150 },
      "data": {
        "type": "action",
        "label": "PD Alert",
        "config": {
          "actionType": "webhook/send-webhook",
          "webhookUrl": "https://events.pagerduty.com/v2/enqueue",
          "webhookMethod": "POST",
          "webhookHeaders": "{\"Content-Type\": \"application/json\"}",
          "webhookPayload": "{\"event_action\":\"trigger\",\"routing_key\":\"...\",\"dedup_key\":\"low-balance\",\"payload\":{\"summary\":\"Wallet balance below 1 ETH\",\"severity\":\"critical\",\"...\":\"...\"}}"
        }
      }
    },
    {
      "id": "pd-resolve",
      "type": "action",
      "position": { "x": 850, "y": 350 },
      "data": {
        "type": "action",
        "label": "PD Resolve",
        "config": {
          "actionType": "webhook/send-webhook",
          "webhookUrl": "https://events.pagerduty.com/v2/enqueue",
          "webhookMethod": "POST",
          "webhookPayload": "{\"event_action\":\"resolve\",\"routing_key\":\"...\",\"dedup_key\":\"low-balance\"}"
        }
      }
    }
  ],
  "edges": [
    { "id": "e1", "source": "trigger",        "target": "check-balance" },
    { "id": "e2", "source": "check-balance",  "target": "condition-low" },
    { "id": "e4", "source": "condition-low",  "target": "pd-alert",   "sourceHandle": "true",  "type": "animated" },
    { "id": "e5", "source": "condition-low",  "target": "pd-resolve", "sourceHandle": "false", "type": "animated" }
  ],
  "integrationBindings": []
}
```

The `webhookPayload` strings have been trimmed for readability; in a real export they hold the full PagerDuty payload verbatim. Notice the two edges out of `condition-low`: one with `sourceHandle: "true"` (alert) and one with `"false"` (resolve). That's how condition nodes encode if/else branches.

### Auto-harvest staking rewards

A simpler 2-node pattern: a daily scheduled trigger reads pending rewards from a staker contract, then writes the harvest call once they cross a threshold. No condition node is needed because the read-then-write chain is unconditional, and the contract reverts if there's nothing to harvest.

```json
{
  "version": 1,
  "exportedAt": "2026-01-01T12:00:00.000Z",
  "workflow": {
    "name": "Auto-harvest Uniswap V3 staker",
    "description": "Daily harvest of staking rewards once they exceed 10 tokens."
  },
  "nodes": [
    {
      "id": "trigger",
      "type": "trigger",
      "position": { "x": 0, "y": 0 },
      "data": {
        "type": "trigger",
        "label": "Daily 12:00 UTC",
        "config": {
          "triggerType": "Schedule",
          "scheduleCron": "0 12 * * *"
        }
      }
    },
    {
      "id": "harvest",
      "type": "action",
      "position": { "x": 0, "y": 160 },
      "data": {
        "type": "action",
        "label": "Harvest rewards",
        "config": {
          "actionType": "web3/write-contract",
          "network": "1",
          "address": "0x789...GHI",
          "functionName": "harvest",
          "args": []
        }
      }
    }
  ],
  "edges": [
    { "id": "e1", "source": "trigger", "target": "harvest" }
  ],
  "integrationBindings": []
}
```

This is the minimum viable export: two nodes, one edge. `exportedAt` and each node's `position` are required, so include them for every node.
