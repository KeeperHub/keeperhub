---
title: "Overview"
description: "KeeperHub is the execution and reliability layer for AI agents operating onchain."
---

# Overview

KeeperHub is the execution and reliability layer for AI agents operating onchain. Build visual workflows that monitor onchain state, execute transactions, and send notifications -- without writing code or managing infrastructure. Works with Ethereum, Base, Arbitrum, Polygon, and other EVM-compatible chains, and with Solana for native SOL and SPL token transfers.

Whether you are a protocol team automating treasury operations, a security team responding to threats, or an AI agent executing onchain actions, KeeperHub handles gas estimation, transaction ordering, retries, and wallet security so you can focus on what to automate, not how to keep it running.

<!-- TODO: Add workflow builder screenshot -->

## Use Cases

- **Treasury monitoring** -- check a vault's collateral ratio on a schedule, call a top-up function when it drops below threshold, send a Telegram alert with the transaction hash
- **Event response** -- listen for contract events (large withdrawals, governance proposals, ownership transfers), evaluate severity, route notifications to Discord and email based on conditions
- **Recurring operations** -- distribute rewards, sweep dust from wallets, call keeper functions on DeFi protocols on a schedule
- **Cross-system integration** -- read contract values, aggregate with Math, post to Discord, fire webhooks to external dashboards
- **Webhook-driven automation** -- accept an HTTP request from your application and trigger an onchain operation in response

## How It Works

Every workflow follows the same model: a **trigger** starts execution, **actions** perform operations, and **conditions** control the flow between them.

### Triggers

Triggers define when a workflow runs:

| Trigger | When it fires |
|---------|---------------|
| **Manual** | When you click Run in the builder |
| **Schedule** | On a recurring interval (every N minutes, hourly, daily) |
| **Webhook** | When an external service sends an HTTP request to your workflow URL |
| **Event** | When a specific smart contract event is emitted onchain |
| **Block** | At regular block intervals on a specific chain |
| **Transfer** | When a payment arrives at a watched address |

### Actions

Actions are the operations your workflow performs:

- **Web3** -- check balances, read and write smart contracts, transfer native tokens and ERC-20s, query event logs, and decode calldata
- **Notifications** -- send messages via Discord, Slack, Telegram, and SendGrid email
- **System** -- HTTP requests, conditional branching, loops (For Each), aggregation (Collect), and template rendering
- **Math** -- compute aggregations over numeric data: sum, count, average, median, min, max, and product

### Conditions and Branching

Condition nodes evaluate data from previous steps and split the workflow into branches. Use them to gate expensive operations behind threshold checks, route alerts by severity, or skip steps when data is unchanged.

### Data Flow Between Nodes

Each node can reference the output of any previous step. This means you can read a balance in one node, compare it against a threshold in the next, and include the exact value in a notification message -- all through built-in references. See [Core Concepts](/concepts) for details on the reference syntax.

### Failure Handling

When a step fails, KeeperHub retries with configurable behavior. Failed runs are logged with full error context in the [Runs panel](/keeper-runs/overview).

## Platform Capabilities

### Supported Chains

KeeperHub operates on Ethereum, Base, Arbitrum, Polygon, Sepolia, and additional EVM-compatible networks. Chain-specific gas defaults are applied automatically based on network conditions and trigger type. See [Gas Management](/wallet-management/gas) for details.

Solana mainnet and devnet are supported for native SOL transfers and SPL token transfers. The same Turnkey wallet holds both an EVM and a Solana address. Contract calls, protocol plugins, and dry runs are EVM only today. See [Web3 Plugin](/plugins/web3) for the Solana actions and [Turnkey Wallets](/wallet-management/turnkey) for how the addresses are provisioned.

The live, authoritative chain list is `GET /api/chains`.

### Turnkey Wallets

Every account is secured with a Turnkey wallet using hardware-backed key storage. Private keys are generated and stored inside secure enclaves and never leave the hardware boundary. Write operations (transfers, contract calls) execute through this wallet. Read-only actions do not require a wallet. See [Turnkey Integration](/wallet-management/turnkey) for the full security and trust model.

### AI-Assisted Workflow Generation

Describe what you want to automate in plain language using the AI prompt at the bottom of the canvas. The AI assistant generates a workflow structure with appropriate triggers, actions, and conditions that you can review and customize before enabling.

### Code Optional

The visual builder handles most use cases without writing code. For teams that prefer programmatic control, the REST API lets you create, update, trigger, and monitor workflows from your own tooling or CI/CD pipelines. See the [API documentation](/api) for endpoints and authentication.

### AI Agent Execution

KeeperHub provides an MCP server that exposes workflow creation and execution as tools for AI agents. Agents can autonomously build, trigger, and monitor blockchain automations through the Model Context Protocol -- making KeeperHub the execution layer where autonomous agents delegate their onchain actions.

## Infrastructure

KeeperHub runs your workflows on managed infrastructure with automatic gas estimation, nonce management, and transaction ordering. Whether triggered by a human, a schedule, or an AI agent, every execution gets the same reliability guarantees. For technical details, see [Gas Management](/wallet-management/gas) and [Turnkey Integration](/wallet-management/turnkey).

## Getting Started

Pick the path that matches how you work:

| You are | Start here |
|---|---|
| Clicking through the app | [Browser](/getting-started/browser) |
| Building an AI agent | [Agent (MCP)](/getting-started/agent) |
| Calling from a backend service | [API](/getting-started/api) |
| Working from a terminal | [CLI](/getting-started/cli) |

All four provision a Turnkey wallet automatically on signup and include a monthly allowance of
sponsored gas, so a first run does not require funding anything. See
[Getting Started](/getting-started).

## Coming from Another Platform?

If you are moving from OpenZeppelin Defender, see the [Defender Migration Guide](/guides/defender-migration) for a step-by-step transition plan.
