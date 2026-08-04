---
title: "MCP Server"
description: "Model Context Protocol server for AI agents to build and manage KeeperHub workflows programmatically."
---

# MCP Server

The KeeperHub MCP server exposes tools over the Model Context Protocol, enabling AI agents to create, execute, and monitor blockchain automation workflows.

## Connect to KeeperHub MCP

### Remote (recommended)

Connect directly to KeeperHub's hosted MCP server. No local process or CLI installation needed.

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Then run `/mcp` inside Claude Code to complete the OAuth authorization via browser. KeeperHub will ask you to approve access, and the token is stored automatically.

For headless or CI environments where browser auth is not available, pass an API key:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

### Via Claude Code Plugin

Install the [Claude Code Plugin](/ai-tools/claude-code-plugin) for additional skills and slash commands on top of the MCP tools. The plugin connects to the same remote endpoint.

### Local via kh CLI (deprecated)

The [`kh` CLI](https://github.com/KeeperHub/cli) can run a local MCP server over stdio via `kh serve --mcp`. This is deprecated in favor of the remote endpoint above and will be removed in a future release.

## Per-Workflow MCP Servers

In addition to the aggregate server at `/mcp`, every listed marketplace workflow is also reachable as its own narrow MCP server at `/mcp/w/<slug>`. The aggregate server exposes the generic `call_workflow(slug, inputs)` dispatcher; the per-workflow form registers a single tool named after the workflow's listed slug, with the workflow's actual input schema and description.

This matters because LLMs select tools from `tools/list` in a single decision step. A typed, named tool with a real input schema is picked in one turn. A generic dispatcher requires a multi-turn discover-then-call dance, costs more tokens, and has lower selection accuracy.

### Install

```bash
claude mcp add --transport http --scope user my-workflow https://app.keeperhub.com/mcp/w/<slug> \
  --header "Authorization: Bearer kh_your_key_here"
```

Replace `<slug>` with the workflow's listed slug (visible on its marketplace page) and `my-workflow` with whatever name you want the server to appear under. The same Bearer-token rules apply — any valid `kh_` API key or OAuth token works.

### What the agent sees

After install, the AI's tool inventory gains exactly one tool: the workflow itself, with its real name as `title`, the workflow's description, and the listed input schema. There is no `search_workflows` step and no `call_workflow` indirection. The LLM picks the tool by name and shape.

### Cross-organization calls

Any valid bearer can call any listed workflow regardless of which organization owns the workflow. Listed workflows are open to all callers by design. Unlisted slugs return 404.

### Paid workflows

Paid listings return an HTTP 402 with an x402 challenge. The MCP transport surfaces this as a tool error with the full challenge body in the response text. To autopay, install the [agentic wallet](/ai-tools/agentic-wallet) — its PreToolUse safety hook intercepts the 402, evaluates the price against your safety thresholds, signs the payment, and retries.

### Compared to the aggregate server

| | Aggregate `keeperhub` MCP | Per-workflow MCP |
|---|---|---|
| URL | `https://app.keeperhub.com/mcp` | `https://app.keeperhub.com/mcp/w/<slug>` |
| Tools | Workflow CRUD, execution, search, `call_workflow`, integrations, templates | Exactly one — the workflow itself |
| Input typing | `call_workflow(slug, inputs: object)` | Workflow's real `inputSchema` |
| Best for | Building, browsing, executing arbitrary workflows in your org | Calling one specific listed workflow |
| Auth | OAuth or `kh_` token | Same |
| Org scoping | Calls scoped to your org | Cross-org calls allowed for listed workflows |

### Removing

```bash
claude mcp remove my-workflow
```

## Authentication

The MCP endpoint supports two authentication methods:

**OAuth 2.1 (browser-based):** When you add the remote MCP server, Claude Code discovers the OAuth metadata at `/.well-known/oauth-authorization-server` and opens a browser for authorization. Tokens are managed automatically (1-hour access tokens, 30-day refresh tokens).

**API keys (headless):** Pass an organization API key (`kh_` prefix) as a Bearer token. Create one at [app.keeperhub.com](https://app.keeperhub.com) under Settings > API Keys > Organisation tab.

## Organization Scoping

Each MCP connection is scoped to a single organization. The org is determined by your authentication method:

- **OAuth:** The org active in your browser session when you approve the authorization request.
- **API key:** The org the key was created in (visible on the API Keys page).

All tools operate within this org -- listing workflows, creating workflows, executing, and viewing integrations. There is no way to access another org's resources from the same connection.

### Switching Organizations

To work with a different org, re-authenticate:

**OAuth (Claude Code):** Switch your active org at [app.keeperhub.com](https://app.keeperhub.com) using the org switcher, then reconnect the MCP server. In Claude Code, remove and re-add the server:

```bash
claude mcp remove keeperhub
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Complete the OAuth flow again -- the new active org will be captured.

**API key:** Create a separate API key in the target org and update the MCP server configuration with the new key.

### Working with Multiple Organizations

If you regularly work across multiple orgs, add a separate MCP server entry for each:

```json
{
  "mcpServers": {
    "keeperhub-acme": {
      "type": "http",
      "url": "https://app.keeperhub.com/mcp",
      "headers": { "Authorization": "Bearer kh_acme_key" }
    },
    "keeperhub-personal": {
      "type": "http",
      "url": "https://app.keeperhub.com/mcp",
      "headers": { "Authorization": "Bearer kh_personal_key" }
    }
  }
}
```

Each server entry has its own tool namespace, so the AI agent can distinguish which org to target based on the server name.

## Tools Reference

The server registers more than 30 tools. Call `tools_documentation` (or `list_action_schemas`) at runtime for the authoritative, always-current set.

### Workflow Management

| Tool | Description |
|------|-------------|
| `list_workflows` | List all workflows for the organization. Optionally filter by `projectId` or `tagId`. |
| `get_workflow` | Get a single workflow by ID, including nodes, edges, and configuration. |
| `create_workflow` | Create a workflow with nodes and edges. Created disabled by default; pass `enabled=true` to make schedule, event, block, or webhook triggers fire immediately. |
| `update_workflow` | Update a workflow's name, description, nodes, edges, project/tag assignment, or enabled state. Set `enabled=false` to stop triggers without deleting the workflow. |
| `delete_workflow` | Permanently delete a workflow. This action is irreversible. |
| `validate_workflow` | Check a workflow's structural and Web3-specific correctness before creating or executing it. |
| `prepare_test_pin_data` | Return the JSON Schema each node expects as pin data, so an agent can construct valid test inputs. |

### Execution

| Tool | Description |
|------|-------------|
| `execute_workflow` | Trigger a manual execution. Returns an execution ID for status polling. |
| `get_execution` | Get combined status and step-by-step logs for an execution in one response. Replaces the earlier `get_execution_status` + `get_execution_logs` pair. |

### Direct On-Chain Execution

| Tool | Description |
|------|-------------|
| `execute_transfer` | Transfer native or ERC20 tokens to a recipient. Requires a wallet integration. |
| `execute_contract_call` | Call a smart contract function. Returns the result for view/pure calls, or an execution ID for state-changing calls. |
| `execute_check_and_execute` | Read a contract value, evaluate a condition, and execute an action if it is met. |
| `get_direct_execution_status` | Get the status of a direct execution (transfer or contract call), including the transaction hash and result. |

### Safely preflight direct writes

All three direct execution tools accept an optional `simulate` boolean. Set it
to `true` first to estimate gas and catch a revert without signing or
broadcasting. If the successful tool result has `success: true` and
`wouldRevert: false`, repeat the tool call with the same transaction arguments,
omit `simulate`, and add a unique `idempotency_key`. Then poll
`get_direct_execution_status` with bounded backoff until it returns `completed`
or `failed`.

For example, preflight a Base Sepolia transfer:

```json
{
  "chain_id": "84532",
  "to_address": "0xRecipient",
  "amount": "0.01",
  "simulate": true
}
```

`simulate` must be the JSON boolean `true`, not the string `"true"`. A
simulation never returns a transaction hash because nothing is broadcast. A
revert or invalid simulation is surfaced as an MCP tool error; the error text
includes the REST error JSON when available. Treat any tool error as a hard
stop. View/pure calls and a check whose condition is false return their normal
read/no-action result instead of a simulation envelope.

Simulation is currently EVM-only. Solana transfers on chain IDs `101` and
`103` can still broadcast through `execute_transfer`, but the MCP tool rejects
`simulate: true` for those IDs and their aliases before making an API call. See
[Direct Execution](/api/direct-execution) for response shapes, retry semantics,
and the authoritative safe first-write sequence.

### Protocol Actions (DeFi)

| Tool | Description |
|------|-------------|
| `search_protocol_actions` | Search available protocol actions across supported DeFi protocols. Call this first to discover actions and their parameters. |
| `execute_protocol_action` | Execute a DeFi protocol action. The `actionType` follows `protocol/action-slug` (for example `aave-v3/supply`). |

### AI Generation

| Tool | Description |
|------|-------------|
| `ai_generate_workflow` | Generate a complete workflow from a natural language description. |

### Action Schemas and Plugins

| Tool | Description |
|------|-------------|
| `list_action_schemas` | List available action schemas, triggers, and supported chains. Each chain includes a `status` field (stable, experimental, deprecated). |
| `get_plugin` | Get schema details for a specific plugin or integration type. |
| `search_plugins` | Deprecated. Use `list_action_schemas` instead. |

### Templates

| Tool | Description |
|------|-------------|
| `search_templates` | Search pre-built workflow templates. |
| `deploy_template` | Clone a public template into the organization as a new workflow. |
| `get_template` | Deprecated. Use `get_workflow` instead. |

### Marketplace Listings

| Tool | Description |
|------|-------------|
| `search_workflows` | Search listed workflows callable by external agents. Returns slug, description, input schema, and price. |
| `call_workflow` | Invoke a listed workflow. Read workflows execute and return a result; write workflows return unsigned calldata. Paid listings return an x402 challenge (this tool does not auto-pay). |
| `list_workflow` | Publish a workflow to the marketplace catalog. Idempotent. |
| `unlist_workflow` | Remove a workflow from the catalog. The slug is preserved for re-listing. |
| `update_workflow_listing` | Edit listing metadata (description, tags, category, chain, schemas). |
| `get_workflow_listing` | Read a workflow's public listing metadata by slug. No auth required. |

### Integrations

| Tool | Description |
|------|-------------|
| `list_integrations` | List configured integrations (credentials) for the organization. |
| `get_wallet_integration` | Get details for a wallet integration, required for web3 write actions. |

### Documentation

| Tool | Description |
|------|-------------|
| `tools_documentation` | Get documentation for the KeeperHub MCP tools, including examples and best practices. |

## Resources

The server exposes two MCP resources:

| URI | Description |
|-----|-------------|
| `keeperhub://workflows` | List of all workflows |
| `keeperhub://workflows/{id}` | Full workflow configuration |

## Creating a Workflow

A typical workflow creation flow:

1. **Discover actions** -- call `list_action_schemas` with a category to see available action types and their required fields
2. **Build nodes** -- construct trigger and action nodes with the correct `actionType` values
3. **Connect nodes** -- define edges from trigger to actions in execution order
4. **Create** -- call `create_workflow` with nodes and edges (auto-layouts positions)
5. **Test** -- call `execute_workflow` and poll `get_execution`

### Node Structure

```json
{
  "id": "check-balance",
  "type": "action",
  "data": {
    "label": "Check Balance",
    "description": "Check wallet ETH balance",
    "type": "action",
    "config": {
      "actionType": "web3/check-balance",
      "network": "11155111",
      "address": "0x..."
    },
    "status": "idle"
  }
}
```

Trigger nodes use `type: "trigger"` with a `triggerType` in the config (`Manual`, `Schedule`, `Webhook`, `Event`, `Block`).

### Edge Structure

Edges connect nodes and define execution flow:

```json
{
  "id": "edge-1",
  "source": "trigger-1",
  "target": "check-balance"
}
```

For **Condition nodes** and **For Each nodes**, edges require a `sourceHandle` field:

```json
{
  "id": "edge-2",
  "source": "condition-1",
  "target": "send-alert",
  "sourceHandle": "true"
}
```

| Source Node Type | sourceHandle Values |
|------------------|---------------------|
| Condition | `"true"` or `"false"` |
| For Each | `"loop"` or `"done"` |
| Other nodes | Omit field |

### Condition Nodes

Condition nodes have dual output paths with `true` and `false` source handles. Connect downstream nodes to the appropriate handle to create if/else logic in a single Condition node.

Conditions support these operators: `==` (soft equals), `===` (equals), `!=` (soft not equals), `!==` (not equals), `>`, `>=`, `<`, `<=`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, `isEmpty`, `isNotEmpty`, `exists`, `doesNotExist`, `isNull`, `isNotNull`, `isUndefined`, `isNotUndefined`.

Conditions reference previous node outputs using template syntax: `{{@nodeId:Label.field}}`.

## Web3 Action Reference

### Read Actions (no wallet required)

| Action | Required Fields |
|--------|----------------|
| `web3/check-balance` | `network`, `address` |
| `web3/check-token-balance` | `network`, `address`, `tokenConfig` |
| `web3/read-contract` | `network`, `contractAddress`, `abi`, `abiFunction` |

### Write Actions (require a wallet integration)

| Action | Required Fields |
|--------|----------------|
| `web3/transfer-funds` | `network`, `recipientAddress`, `amount` |
| `web3/transfer-token` | `network`, `recipientAddress`, `tokenConfig`, `amount` |
| `web3/write-contract` | `network`, `contractAddress`, `abi`, `abiFunction` |

`tokenConfig` is a token-select value (which token on which network), not a bare address. Write actions require the organization's wallet integration to be configured; there is no per-action `walletId` field. Use `get_wallet_integration` to confirm the wallet is set up.

The `network` field accepts chain IDs as strings: `"1"` (Ethereum mainnet), `"11155111"` (Sepolia), `"8453"` (Base), `"42161"` (Arbitrum), `"137"` (Polygon).

### `abiFunction` field

For `web3/read-contract` and `web3/write-contract`, the `abiFunction` field is the function as it appears in the contract's ABI. Pass the plain name for unique functions (`"balanceOf"`) or the full signature for overloaded ones (`"transfer(address,uint256)"`).

## Error Handling

All tools return errors in this format:

```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true
}
```

| Code | Meaning |
|------|---------|
| 401 | Invalid or missing API key |
| 404 | Workflow or execution not found |
| 400 | Invalid parameters |
| 500 | Server error |
