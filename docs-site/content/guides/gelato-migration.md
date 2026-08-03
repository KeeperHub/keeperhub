---
title: "Migrate from Gelato Functions"
description: "Gelato Web3 Functions shuts down March 31, 2026. A practical migration guide covering feature mapping, self-built vs managed options, and step-by-step migration."
---

# Migrate from Gelato Functions

Gelato Web3 Functions shuts down on **March 31, 2026**. This guide covers what's affected, how to evaluate your options, and how to migrate to KeeperHub.

## What's Changing

Gelato is sunsetting its Web3 Functions platform. Three core components are affected:

- **Typescript Functions** -- off-chain logic connecting smart contracts to HTTP APIs, subgraphs, and databases
- **Solidity Functions** -- on-chain condition checking and automated contract execution
- **Automated Transactions** -- time-based and event-based contract calls with predefined inputs

This follows the earlier sunset of Gelato's Legacy Automate service in June 2024. Teams that migrated from Legacy Automate to Functions now need to move again.

> **Key constraint**: Gelato Functions tasks are tied to Gelato's dedicated `msg.sender` addresses and task IDs. Any smart contracts that whitelist Gelato's executor addresses or rely on Gelato-specific callback patterns will need their permissions updated. This applies regardless of which path you choose.

## Comparison

| Capability | KeeperHub | Self-Built Replacement |
|---|---|---|
| **Infrastructure** | Managed | You manage servers, cron jobs, RPC nodes |
| **Setup time** | Minutes | Weeks to months |
| **Off-chain logic** | Visual workflow builder, AI-assisted creation | Custom serverless functions (AWS Lambda, etc.) |
| **Gas optimization** | Smart Gas Estimation (~30% savings) | Manual tuning per chain |
| **Transaction retry** | Intelligent retry + nonce management (up to 10 attempts) | Build your own retry logic |
| **Key management** | Non-custodial Turnkey wallets (secure enclave) | Self-managed HSM / KMS / hot wallets |
| **Multi-chain** | Unified multi-chain workflows | Separate deployments per chain |
| **Monitoring** | Built-in execution analytics and alerts | Build or integrate third-party tools |
| **Alerting** | Slack, Discord, Email, Telegram, Webhook | Custom integration per channel |
| **Support** | 24/7 human DevOps team | Your team is the support team |
| **Uptime guarantee** | 100% uptime track record (7+ years) | Your responsibility |

## Feature Mapping

### Typescript Functions --> Workflow Automation + Webhook Plugin

Off-chain computation, API calls, and conditional logic that determined when and how to execute on-chain. The core of most Gelato automations. KeeperHub replaces custom Typescript with a visual workflow builder and pre-built plugins for common integrations (price feeds, subgraphs, webhooks). Workflows can also be generated from plain-language descriptions using the AI assistant.

### Solidity Functions --> Watcher + Poker Nodes

On-chain condition checking and automated contract execution. Used for yield harvesting, limit orders, liquidation protection, and similar patterns. KeeperHub adds Smart Gas Estimation that adapts to congestion in real time, intelligent retry logic with exponential backoff across up to 10 attempts, and multi-node resilience so provider outages do not stop execution.

### Automated Transactions --> Scheduled Workflows

Time-based and event-based contract calls with predefined inputs. The simplest Gelato task type, used for recurring on-chain operations. KeeperHub adds visual scheduling with conditional branching. Chain multiple actions into a single workflow instead of managing separate tasks. Full execution history and audit trails for every run.

### Gelato Relay --> Poker Nodes + Smart Gas Engine

Gasless transaction relaying and meta-transaction support. KeeperHub adds ~30% gas savings through intelligent estimation, non-custodial wallet management via Turnkey, and transaction simulation before execution to catch failures before they cost gas.

### Dedicated msg.sender to Non-Custodial Turnkey Wallets

Gelato assigned dedicated executor addresses for task execution. KeeperHub uses non-custodial Turnkey wallets that you control. Full key ownership without managing key infrastructure. No vendor lock-in on your execution addresses.

### Additional Capabilities

**Calldata Decoder** -- human-readable transaction analysis, available as a workflow component that can feed into conditional logic or alerting.

**AI Risk Assessment** -- hybrid rules + LLM-based transaction evaluation before execution, available as a reusable workflow component.

**MCP Server** -- connect autonomous AI agents directly to on-chain execution through KeeperHub's Model Context Protocol server.

All three ship as workflow plugins and can be chained with monitoring triggers and notification channels.

## Migration Steps

### 1. Inventory Your Gelato Tasks

Export your task list from the Gelato dashboard. For each task, document the trigger type (time, event, or custom function), target contract addresses, function signatures, and any off-chain API dependencies your Typescript Functions rely on.

### 2. Set Up KeeperHub

Create your account, configure chain connections, and provision your non-custodial Turnkey wallet for transaction signing.

### 3. Recreate Your Workflows

Use the workflow builder or AI assistant to recreate your automations. Typescript Functions become no-code workflows. Solidity Functions map to Watcher + Poker node combinations. Check the [Workflow Hub](/workflows/hub) for templates covering common patterns like balance monitoring, contract execution, and multi-step alerting.

### 4. Parallel Run, Then Cut Over

Run KeeperHub alongside Gelato to validate behavior. Once confirmed, update your smart contract permissions (whitelists, access control) to the new KeeperHub executor addresses and disable the Gelato tasks.

### Estimated Timelines

- **Simple setup** (1-5 automated transactions or simple functions): 1 to 2 days
- **Medium setup** (5-15 tasks with mixed Typescript and Solidity functions): 3 to 5 days
- **Complex setup** (15+ tasks with custom off-chain logic and multi-chain deployments): 1 to 2 weeks with dedicated KeeperHub support

---

For help with migration planning, [book a call](https://calendar.app.google/kFfcLkMMc9d64is26) or reach out in our Discord.
