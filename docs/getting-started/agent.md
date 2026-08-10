---
title: "Agent (MCP)"
description: "Connect an AI agent to KeeperHub over the Model Context Protocol, then create, run, and verify workflows as tool calls."
---

# Getting Started with an Agent

KeeperHub exposes workflows, executions, and direct onchain execution as
[Model Context Protocol](https://modelcontextprotocol.io) tools, so an agent can build and run
automations without a browser.

## 1. Connect

The hosted server is at `https://app.keeperhub.com/mcp`. In Claude Code:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Run `/mcp` to complete OAuth in your browser. That mints a short-lived Bearer access token, which
is the right credential for an interactive agent.

For headless or CI environments where no browser redirect is possible, pass an organization API
key instead:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

Create that key in the app under your avatar, then **API Keys**, then the **Organisation** tab.
Organization keys start with `kh_`. User keys (`wfb_`) authenticate webhook triggers and are not
interchangeable. See [API Keys](/api/api-keys).

Confirm the connection by asking your agent to list your workflows.

## 2. Know the tools you need

The server exposes more than forty tools. Four cover the whole first loop:

| Tool | Does |
|---|---|
| `list_workflows` | Find a workflow and its id |
| `execute_workflow` | Start a run, returns an execution id |
| `get_execution` | Read status, output, and transaction hashes for a run |
| `ai_generate_workflow` | Scaffold a workflow from a plain-language description |

`get_execution_status` and `get_execution_logs` still resolve, but both are deprecated aliases of
`get_execution`. `search_plugins` is a deprecated alias of `list_action_schemas`, and `get_template`
of `get_workflow`. Prefer the current names.

The full list, including workflow CRUD, templates, integrations, and marketplace listings, is in
the [MCP Server reference](/agent/mcp-server).

## 3. Run a workflow

Ask the agent to run one. `execute_workflow` returns an execution id immediately rather than
waiting for the result, then `get_execution` reads the outcome.

A run reaches one of these terminal states:

| Status | Meaning |
|---|---|
| `success` | Completed |
| `error` | Failed from bad input, workflow logic, or an external dependency |
| `system_error` | Failed inside KeeperHub infrastructure |
| `cancelled` | Stopped before completing |

`pending`, `running`, and `unconfirmed` are non-terminal: keep reading until you see one of the
four above. Treat anything other than `success` as a failure. Checking only for `error` misses
`system_error` and `cancelled`.

## 4. Write onchain, safely

For a one-off transfer or contract call with no workflow around it, use the direct execution
tools: `execute_transfer`, `execute_contract_call`, `execute_protocol_action`.

Always preflight:

1. Call the tool with `simulate: true`.
2. Continue only when the result reports `success: true` and `wouldRevert: false`.
3. Repeat the call with `simulate` omitted, passing a fresh `idempotency_key`.
4. Poll `get_direct_execution_status` with the returned `executionId` until it is terminal. Wait
   the number of seconds in the `X-Poll-Interval-Hint` response header between polls; `0` means
   the execution is terminal and you can stop.
5. Keep `transactionLink` from the terminal response as the onchain proof.

**Simulation is EVM-only.** On Solana mainnet (`101`) and devnet (`103`), a `simulate: true` call
resolves with `isError: true` rather than throwing. Parse the JSON in `content[0].text` and stop
when `error` is `simulation_unsupported_chain`:

```json
{
  "error": "simulation_unsupported_chain",
  "message": "Direct-execution simulation is not supported on this chain.",
  "chain_id": 101,
  "hint": "Direct-execution simulation is EVM-only. Preflight with a Solana-aware client before broadcasting."
}
```

Solana transfers can still broadcast; only the preflight is unavailable.

## Per-workflow servers

Any listed marketplace workflow is also reachable as its own typed MCP server at
`https://app.keeperhub.com/mcp/w/<slug>`, exposing that single workflow with its real input schema
instead of the full toolset. See [MCP Server](/agent/mcp-server).

## Rate limits

| Context | Limit |
|---|---|
| MCP, per organization | 120 requests / minute |
| Public MCP `tools/call`, per IP | 10 requests / minute |
| Direct execution, per API key | 60 requests / minute |

Rate-limited requests return `429` with a `Retry-After` header in seconds. Wait at least that
long, then back off exponentially. Pass a stable `idempotency_key` on writes so a retry cannot
double-spend.

## Next

- [MCP Server](/agent/mcp-server) for the complete tool reference
- [Zero to a Verified Onchain Transaction](/guides/first-verified-transaction) to take a new
  integration all the way to a transaction you have independently confirmed landed
- [Platform Reference](/platform-reference) for chains, USDC addresses, and faucets
- [Claude Code Plugin](/agent/claude-code-plugin) if Claude Code is your host
