---
title: "Getting Started"
description: "Four ways to drive KeeperHub. Pick the one that matches how you work and get to a first result."
---

# Getting Started

KeeperHub can be driven four ways. They reach the same workflows, executions, and wallet, so the
only question is which one fits what you are building.

| You are | Start here |
|---|---|
| Clicking through the app at app.keeperhub.com | [Browser](/getting-started/browser) |
| Building an AI agent that should create and run workflows | [Agent (MCP)](/getting-started/agent) |
| Calling KeeperHub from a backend service or CI job | [API](/getting-started/api) |
| Working from a terminal, or scripting a deploy | [CLI](/getting-started/cli) |

Every path ends with a workflow you have run and a result you can check.

## What you get on signup

Signing up provisions a non-custodial [Turnkey wallet](/wallet-management/turnkey) for your
organization automatically. You do not create it, and KeeperHub never holds its keys.

Your organization also receives a monthly allowance of sponsored gas on mainnet, so early runs
execute without you funding anything first. Sponsorship covers the network fee only: a workflow
that sends 0.1 ETH still needs 0.1 ETH in the wallet. See
[Gas Management](/wallet-management/gas) for the full set of conditions.

Read-only workflows, including most monitoring, never need a funded wallet at all.

### Your first transaction, without funding anything

Sponsored gas covers the network fee, and a write that moves no tokens needs nothing else. So you
can land a real mainnet transaction before you fund anything at all: call `approve(spender, 0)` on
any ERC-20 contract.

It changes state, it produces a transaction hash you can open on a block explorer, and it transfers
nothing, so it succeeds on an empty wallet. USDC on Base is
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and any address will do as the spender.

Worth knowing because most templates read data and send alerts. Those are useful, but they produce
no transaction, so they cannot give you the moment where you see your own hash confirm on mainnet.
A zero-value write is the shortest path to that.

## If you are new to the model

A workflow is a **trigger** plus a sequence of **actions**, with **conditions** to branch between
them. [Core Concepts](/concepts) covers the vocabulary; you do not need it to finish any of the
four paths above.



