---
title: "Migrate from OpenZeppelin Defender"
description: "OpenZeppelin Defender shuts down July 1, 2026. A practical migration guide covering feature mapping, self-hosted vs managed options, and step-by-step migration."
---

# Migrate from OpenZeppelin Defender

OpenZeppelin Defender shuts down on **July 1, 2026**. This guide covers what's changing, how to evaluate your options, and how to migrate to KeeperHub.

## What's Changing

Defender is in maintenance mode. Two core services are affected:

- **Defender Monitor** -- on-chain monitoring and alerting
- **Defender Relayer** -- transaction signing and submission

OpenZeppelin has released self-hosted replacements:

- [**OpenZeppelin Monitor**](https://github.com/OpenZeppelin/openzeppelin-monitor) -- Rust-based monitor with YAML configuration
- [**OpenZeppelin Relayer**](https://github.com/OpenZeppelin/openzeppelin-relayer) -- transaction relayer supporting EVM, Solana, and Stellar

Both are functional but require you to provision and operate the infrastructure (Redis, Docker, monitoring, on-call).

> **Key constraint**: Private keys cannot be exported from Defender's AWS KMS. Every migration requires generating new signer addresses and updating all on-chain permissions (access control, whitelists, allowlists). This applies regardless of which path you choose.

## Comparison

| Capability | KeeperHub | Self-Hosted (OZ Monitor + Relayer) |
|---|---|---|
| **Infrastructure** | Managed | You run Redis, Rust services, Docker |
| **Setup time** | Minutes | Days to weeks |
| **Monitoring** | Visual workflow builder, AI-assisted creation | YAML config files |
| **Alerting** | Slack, Discord, Email, Telegram, Webhook | Slack, Discord, Email, Webhook, Scripts |
| **Transaction execution** | Gas optimization, retry with nonce management | Basic gas estimation, manual retry config |
| **Key management** | Non-custodial Turnkey wallets (secure enclave) | Local keystore, AWS KMS, GCP KMS, Vault, Turnkey |
| **Multi-chain** | EVM and Solana | EVM, Solana, Stellar |
| **SDK migration** | REST API + workflow builder | Replace `defender-sdk` with `relayer-sdk` |
| **License** | Commercial (open-source core) | AGPL-3.0 |

## Feature Mapping

### Defender Monitor --> Workflow Monitoring

Event monitoring, custom filtering, and multi-chain support. KeeperHub adds conditional logic branching and multi-step response chains through the workflow builder.

### Defender Relayer --> Transaction Execution

Transaction submission, signing, and nonce management. KeeperHub adds gas optimization, automatic retry logic, and multi-node resilience for provider failover.

### Defender Actions --> Workflow Automation

Defender Actions ran custom serverless scripts. In KeeperHub, these become visual workflows -- built through the canvas or generated with the AI assistant. The [Workflow Hub](/workflows/hub) has templates for common patterns like balance monitoring, contract execution, and multi-step alerting.

### Additional Capabilities

**Calldata Decoder** -- human-readable transaction analysis, available as a workflow component that can feed into conditional logic or alerting.

**AI Risk Assessment** -- hybrid rules + LLM-based transaction evaluation before execution, available as a reusable workflow component.

Both ship as workflow plugins and can be chained with monitoring triggers and notification channels.

## Migration Steps

### 1. Audit Your Defender Setup

Export your configuration from the Defender dashboard. Document every monitor, relayer, and action -- contract addresses, event signatures, trigger conditions, and relayer permissions.

### 2. Set Up KeeperHub

Create your account, configure chain connections, and set up your wallet for transaction signing.

### 3. Recreate Your Workflows

Use the workflow builder or AI assistant to recreate your automations. Check the [Workflow Hub](/workflows/hub) for templates that match your existing patterns.

### 4. Run in Parallel

Run both systems side by side to validate that KeeperHub matches Defender's behavior. Once confirmed, update on-chain permissions to your new signer addresses and decommission Defender.

---

For help with migration planning, [book a call](https://calendar.app.google/kFfcLkMMc9d64is26) or reach out in our Discord.
