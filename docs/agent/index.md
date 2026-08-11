---
title: "Overview"
description: "Reference for driving KeeperHub from AI agents: the MCP server, the Claude Code plugin, and agentic wallets."
---

# Agent Tools

Reference for the surfaces an AI agent uses to build, run, and pay for KeeperHub workflows. To
connect an agent for the first time, start with
[Getting Started with an Agent](/getting-started/agent).

| Surface | What it does | Best for |
|------|-------------|----------|
| [MCP Server](/agent/mcp-server) | Model Context Protocol server with more than forty tools covering workflow CRUD, execution, and direct onchain writes | AI agents, custom integrations, remote automation |
| [Claude Code Plugin](/agent/claude-code-plugin) | Skills and slash commands on top of the MCP tools | Developers working inside Claude Code |
| [Agentic Wallets](/agent/agentic-wallet) | An x402 / MPP wallet so an agent can pay for workflows | Agents calling paid marketplace workflows |

## Authentication

The MCP server accepts either credential on each request:

- An **OAuth access token**, minted in the browser (for example `/mcp` in Claude Code). Short-lived
  and the right choice for an interactive agent.
- An **organization API key** (`kh_`), created under your avatar, then **API Keys**, then the
  **Organisation** tab. Long-lived and the right choice for headless, CI, and Docker.

User-scoped keys (`wfb_`) authenticate webhook triggers and do not work here. See
[API Keys](/api/api-keys).

## Authoring and testing workflows

- [MCP Trigger Inputs](/agent/mcp-trigger-inputs) - the input schema each trigger type expects
- [Validate Workflow](/agent/mcp-validate-workflow) - catch structural problems before saving
- [Test Workflow](/agent/mcp-test-workflow) - pin test data and dry-run a workflow
