---
title: "Concepts"
description: "KeeperHub CLI Concepts"
---

# Concepts

## What is KeeperHub

KeeperHub is a Web3 automation platform. You build workflows in a visual editor that connect blockchain protocols (Aave, Uniswap, etc.) with off-chain triggers and actions. Workflows run in KeeperHub's managed execution environment.

## CLI vs Web UI

| Task | Use |
|------|-----|
| Building and editing workflows | Web UI (visual editor) |
| Running workflows in CI/CD | CLI (`kh workflow run`) |
| Scripting protocol calls | CLI (`kh execute contract-call`) |
| Monitoring run status | Either |
| AI-assisted workflow creation | CLI in MCP mode |

## Authentication Model

The CLI supports three authentication methods, checked in this order:

1. **API key** (`KH_API_KEY` environment variable) -- preferred for CI/CD
2. **OS keyring token** -- stored by `kh auth login` browser flow
3. **hosts.yml token** -- fallback for environments without a keyring

Run `kh auth login` to authenticate via browser OAuth. For headless environments, create an API key in the KeeperHub web UI and set `KH_API_KEY`.

Run `kh auth status` to see which method is active and whether your token is valid.

## Output Formats

By default, most commands render a human-readable table. Use these flags for machine-readable output:

- `--json` -- emit raw JSON
- `--jq <expr>` -- filter JSON with a jq expression (implies `--json`)

Examples:
```
kh workflow list --json
kh workflow list --jq '.[].id'
kh run status <id> --json | jq '.status'
```

## Configuration

Configuration is stored in XDG-standard paths:

| File | Default path | Purpose |
|------|-------------|---------|
| `config.yml` | `~/.config/kh/config.yml` | Default host, output preferences |
| `hosts.yml` | `~/.config/kh/hosts.yml` | Per-host tokens and headers |

Override with `XDG_CONFIG_HOME`. Use `kh config list` to view current config and `kh config set` to update values.

## MCP Server Mode

MCP (Model Context Protocol) lets AI assistants discover and call tools via a standard JSON-RPC protocol. Running `kh serve --mcp` starts an MCP server that exposes KeeperHub's workflow execution and protocol actions as tools.

The server reads all available actions from `/api/mcp/schemas` on startup and registers each as an MCP tool. The AI assistant can then call these tools to execute workflows, query protocols, and manage resources on your behalf.

The server communicates over stdin/stdout. When integrated with Claude Desktop, the host application manages the process lifecycle. See [Quickstart](./quickstart) for setup instructions.
