---
title: "Overview"
description: "Use AI agents and developer tools to build and manage KeeperHub workflows programmatically."
---

# AI Tools

KeeperHub provides two integration surfaces for AI-assisted and programmatic workflow management:

| Tool | What it does | Best for |
|------|-------------|----------|
| [Claude Code Plugin](/ai-tools/claude-code-plugin) | Skills and commands for building workflows from your terminal | Developers using Claude Code as their IDE |
| [MCP Server](/ai-tools/mcp-server) | Model Context Protocol server with more than 30 tools for full workflow CRUD | AI agents, custom integrations, remote automation |

Both connect to the same KeeperHub API and require an organization-scoped API key (prefix: `kh_`).

## Quick Start

**Claude Code users:** Install the plugin and run `/keeperhub:login` to get started. The plugin auto-installs the MCP server and configures authentication.

**AI agent builders:** Point your agent framework at KeeperHub's hosted MCP endpoint (`https://app.keeperhub.com/mcp`) with an organization API key. See [MCP Server](/ai-tools/mcp-server) for setup.

## Getting Your API Key

1. Log in at [app.keeperhub.com](https://app.keeperhub.com)
2. Click your avatar, then "API Keys", then the "Organisation" tab
3. Click "New API Key" and name it (e.g., "Claude Code Plugin")
4. Copy the key immediately -- it is only shown once

The key must be organization-scoped (starts with `kh_`). User-scoped keys (`wfb_` prefix) are not supported.
