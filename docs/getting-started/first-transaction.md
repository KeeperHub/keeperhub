---
title: "First Transaction via MCP"
description: "Connect to KeeperHub MCP from a plain Node.js script and execute your first onchain transfer in 15 minutes — no SDK, no Claude Code, no frameworks required."
---

# First Transaction via MCP (Headless Quick Start)

This guide gets you from zero to a confirmed onchain transaction through KeeperHub MCP using plain Node.js — no Claude Code, no SDK, no framework. If you're building an autonomous agent or integrating KeeperHub into a backend, start here.

## Prerequisites

- Node.js 22+ (for built-in `fetch`)
- A KeeperHub account (free — sign up at [app.keeperhub.com](https://app.keeperhub.com))
- A small amount of USDC + ETH on Base (~$1 USDC and ~$0.10 ETH is plenty)

## Step 1: Create an API Key

1. Go to **Settings → API Keys → Organisation** tab
2. Click **Create API Key**
3. Copy the key — it starts with `kh_`

## Step 2: Find Your Execution Wallet

Your KeeperHub wallet is automatically provisioned when you verify your email. Find its address via the UI:

1. Click your profile icon → **Wallet**
2. Copy the wallet address (starts with `0x...`)

> **⚠️ Important:** If you also install the `@keeperhub/wallet` CLI (`keeperhub-wallet add`), that creates a **separate** wallet stored in `~/.keeperhub/wallet.json`. The CLI wallet and the MCP execution wallet are **different addresses**. Always fund the wallet shown in your KeeperHub dashboard or returned by `list_integrations` via MCP.

## Step 3: Fund Your Wallet

Send to your execution wallet address on **Base** (not Ethereum mainnet — gas is too expensive there):

- **0.5–1 USDC** — for transfers
- **0.001–0.01 ETH** — for gas fees

You can bridge to Base via [bridge.base.org](https://bridge.base.org) or buy directly on a DEX.

## Step 4: The MCP Handshake

KeeperHub MCP uses JSON-RPC 2.0 over HTTP. After calling `initialize`, you must:

1. **Capture the session ID from the RESPONSE HEADERS** (not the body) — look for the `mcp-session-id` header
2. **Send a `notifications/initialized` message** — this is required before any tool calls
3. **Include the session ID header** on all subsequent requests

```javascript
const MCP_URL = "https://app.keeperhub.com/mcp";
const API_KEY = process.env.KEEPERHUB_API_KEY;

// 1. Initialize
const initRes = await fetch(MCP_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "my-agent", version: "1.0.0" },
    },
  }),
});

// Session ID is in the HEADERS, not the body
const sessionId = initRes.headers.get("mcp-session-id");

// 2. Send initialized notification
await fetch(MCP_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
    "mcp-session-id": sessionId,
  },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});

// 3. Now you can call tools — always include the session ID header
```

## Step 5: Simulate Before You Execute

Always pass `simulate: true` before executing for real. This runs a dry-run without signing or broadcasting — it catches balance issues, wrong addresses, and would-be reverts for free.

```javascript
// Simulate a USDC transfer on Base
const simRes = await fetch(MCP_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
    "mcp-session-id": sessionId,
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: {
      name: "execute_transfer",
      arguments: {
        chain_id: "8453",                                    // Base mainnet (STRING, not number)
        to_address: "0xYourWalletAddress",
        amount: "0.001",                                     // Human-readable amount
        token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
        simulate: true,                                       // Dry run!
      },
    },
  }),
});

const simData = await simRes.json();
if (simData.result.isError) {
  console.error("Simulation failed:", simData.result.content[0].text);
  return; // Don't execute for real
}
```

## Step 6: Execute for Real

Same arguments, just remove `simulate`:

```javascript
const execRes = await fetch(MCP_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
    "mcp-session-id": sessionId,
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: {
      name: "execute_transfer",
      arguments: {
        chain_id: "8453",
        to_address: "0xYourWalletAddress",
        amount: "0.001",
        token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        // No simulate field — this is the real thing
      },
    },
  }),
});

const execData = await execRes.json();
const result = JSON.parse(execData.result.content[0].text);
console.log("Transaction:", `https://basescan.org/tx/${result.txHash}`);
```

## Common Token Addresses

| Token | Chain | chain_id | token_address |
|-------|-------|----------|---------------|
| ETH (native) | Base | 8453 | (omit token_address) |
| USDC | Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC | Ethereum | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| ETH (native) | Ethereum | 1 | (omit token_address) |

## Gotchas

1. **Two wallets exist** — the CLI wallet (`keeperhub-wallet add`) and the MCP execution wallet are different. Always check `list_integrations` to find the one MCP uses.

2. **Session ID is in headers** — after `initialize`, grab `mcp-session-id` from the response headers. Without it, all subsequent calls fail silently.

3. **Always simulate first** — pass `simulate: true` before executing. It catches balance issues and would-be reverts without spending gas.

4. **Field names matter** — `execute_transfer` uses `to_address` (not `to`), `chain_id` (not `network`), and `token_address` (not `token`). Call `tools/list` to see the exact schema for any tool.

5. **Fund the right wallet** — send USDC and ETH to the address from `list_integrations` or the dashboard, not the CLI wallet address.
