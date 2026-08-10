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

## If you are new to the model

A workflow is a **trigger** plus a sequence of **actions**, with **conditions** to branch between
them. [Core Concepts](/concepts) covers the vocabulary; you do not need it to finish any of the
four paths above.
