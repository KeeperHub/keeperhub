---
title: "Workflows"
description: "Build sophisticated blockchain automations with the visual workflow builder."
---

# Workflows

Workflows are the core of KeeperHub - visual automations that connect triggers, actions, and conditions to create powerful blockchain operations without writing code.

## What are Workflows?

A workflow is a visual representation of an automation. Instead of writing code or managing infrastructure, you build workflows by connecting nodes on a canvas:

- **Triggers** start your workflow (on a schedule, via webhook, on blockchain events, every N blocks, or manually)
- **Actions** perform operations (check balances, call smart contracts, send notifications)
- **Conditions** add branching logic based on action results

## The Visual Workflow Builder

KeeperHub's workflow builder provides an intuitive canvas where you design automations visually:

- **Drag-and-drop nodes** to build your automation flow
- **Connect nodes** with edges to define execution order
- **Configure nodes** using the right-side panel
- **Test workflows** with the Run button before enabling automated execution

## Node Types

### Trigger Nodes

Every workflow starts with a trigger that determines when it runs:

| Trigger | Description |
|---------|-------------|
| Manual | Run only when you click the Run button |
| Schedule | Run at intervals (every 5 minutes, hourly, daily, etc.) |
| Webhook | Run when an external service calls your workflow URL |
| Event | Run when a blockchain event is detected |
| Block | Run every N blocks on a chosen network |
| Transfer | Run when a payment arrives at a watched address |

### Action Nodes

Actions perform the actual work in your workflow:

| Category | Actions |
|----------|---------|
| Web3 | Get Native Token Balance, Get ERC20 Token Balance, Read Contract, Write Contract, Transfer Native Token, Transfer ERC20 Token, Approve ERC20 Token |
| Notifications | Send Email, Send Discord Message, Send Slack Message, Send Telegram Message |
| Integrations | Send Webhook, Custom HTTP requests |

Names here match the labels in the action grid. The live list, including every protocol plugin, is
in the [Plugins](/plugins) reference.

### Condition Nodes

A condition node evaluates a value from an earlier node against a target using a comparison operator (equals, greater than, less than, and so on) and branches the workflow based on the result. See [Creating Workflows](/workflows/creating) for the available operators.

## Building Your First Workflow

See [Getting Started in the Browser](/getting-started/browser) for a step-by-step walkthrough from
signup to a run you can read the result of.

## AI-Assisted Workflow Creation

Use the **Ask AI...** prompt at the bottom of the canvas to describe what you want to automate. The AI assistant will help you build the workflow structure and suggest node configurations.

## Hub

Browse the [Hub](/workflows/hub) to discover workflow templates shared by the community and import them into your workspace.
