---
title: "What is KeeperHub"
description: "KeeperHub is the execution and reliability layer for AI agents operating onchain."
---

# What is KeeperHub

KeeperHub is the execution and reliability layer for AI agents operating onchain. It is not an agent framework and does not replace your agent. It is the infrastructure agents plug into when they need to transact onchain with guarantees: retry logic, gas optimization, private routing, transaction simulation, and SLA-backed execution.

## The Problem KeeperHub Solves

AI agents can reason, but they cannot reliably transact onchain. When an agent needs to move value, it runs into:

- Failed transactions with no retry logic
- Gas spikes that cause operations to stall or overpay
- MEV extraction from unprotected public mempool submission
- No audit trail for what was triggered, simulated, or executed
- No human support when something goes wrong at 3am

## The KeeperHub Solution

KeeperHub provides the execution layer that sits between agent intent and onchain settlement:

- **Reliable execution engine**: Smart gas estimation, intelligent retry logic, and MEV protection via private routing
- **Transaction simulation**: Every transaction is simulated before submission to catch failures before they cost gas
- **Full audit trail**: Every trigger, simulation, submission, gas cost, outcome, and timestamp is logged and exportable
- **Managed DeFi**: 24/7 global engineering support with named engineers and SLA-backed uptime
- **Wallet security**: Non-custodial key management via Turnkey. Teams connect their own wallets. KeeperHub never holds private keys.

## Key Benefits

**For AI agent developers**: Give your agent reliable onchain execution without building gas management, retry logic, or MEV protection from scratch.

**For DeFi protocols**: Automate treasury operations, vault monitoring, and keeper functions with a full audit trail and human support behind every execution.

**For enterprises and treasuries**: SLA-backed execution, named engineering support, and complete auditability for every onchain action.

**For agent framework teams**: Native integration via MCP server, CLI, x402, and MPP. KeeperHub plugs into your stack without replacing it.
