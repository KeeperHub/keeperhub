---
title: "Plugins"
description: "Available workflow plugins for blockchain operations, notifications, and integrations."
---

# Plugins

Plugins provide the actions available in your workflows. Each plugin adds one or more actions that you can drag onto the workflow canvas and configure.

## Available Plugins

| Plugin | Category | Actions | Credentials Required |
|--------|----------|---------|---------------------|
| [Web3](/plugins/web3) | Blockchain | Balance checks, contract reads/writes, transfers, calldata decoding, risk assessment | Wallet (for writes) |
| [Code](/plugins/code) | Code | Execute custom JavaScript in a sandboxed VM | None |
| [Math](/plugins/math) | Math | Aggregation operations (sum, count, average, median, min, max, product) | None |
| [Safe](/plugins/safe) | Protocol | Safe multisig owners, threshold, nonce, module status, pending transactions | API key (for pending txs) |
| [Ajna](/plugins/ajna) | Protocol | Liquidation keeper operations, vault rebalancing, buffer management | Wallet (for writes) |
| [Sky](/plugins/sky) | Protocol | USDS savings, token balances, approvals, DAI/MKR converters | Wallet (for writes) |
| [Discord](/plugins/discord) | Notifications | Send messages to channels | Webhook URL |
| [Telegram](/plugins/telegram) | Notifications | Send messages to chats | Bot token |
| [SendGrid](/plugins/sendgrid) | Notifications | Send emails | API key |
| [Webhook](/plugins/webhook) | Integrations | Send HTTP requests to external services | None |

## How Plugins Work

1. **Add an action** -- Drag a plugin action from the action panel onto your workflow canvas
2. **Configure inputs** -- Set parameters in the right-side panel. Use `{{NodeName.field}}` to reference outputs from previous steps
3. **Connect nodes** -- Wire the action into your workflow flow using edges
4. **Run** -- Execute the workflow. Each action runs in sequence following the edges

## Plugin Categories

### Blockchain (Web3)

Core on-chain operations: reading balances, calling smart contracts, transferring tokens, and security analysis. Read-only actions work without a wallet. Write actions require a connected Para wallet.

### Code

Execute custom JavaScript in a sandboxed VM environment with access to workflow data via template variables. Use for data transformation, aggregation, external API calls, and complex conditional logic. No credentials required.

### Math

Pure computation nodes for aggregating numeric values from upstream nodes. Supports sum, count, average, median, min, max, and product operations with optional post-aggregation arithmetic. Automatically handles large integers using BigInt arithmetic to preserve precision.

### Security

Security-focused actions for transaction analysis, risk assessment, and Safe multisig monitoring. These actions use `maxRetries = 0` (fail-safe behavior) to ensure errors block execution rather than silently retrying.

### Notifications

Send alerts and messages through Discord, Telegram, email, and webhooks. Typically used as the final step in monitoring workflows to notify your team when conditions are met.

### Integrations

Connect to external services via webhooks and HTTP requests. Use these to trigger external systems, update dashboards, or integrate with third-party tools.
