---
title: "FAQ"
description: "Frequently asked questions about KeeperHub - getting started, security, workflows, pricing, and more."
---

# Frequently Asked Questions

## Getting started

### What is KeeperHub?

KeeperHub is a no-code blockchain automation platform. You build visual workflows that monitor onchain state, execute transactions, and send notifications -- without writing code or managing infrastructure. It works with Ethereum, Base, Arbitrum, Polygon, and other EVM-compatible chains.

People use it for things like treasury monitoring, DeFi position management, event-driven alerting, and recurring onchain operations (reward distribution, collateral top-ups, that sort of thing).

### How do I get started?

1. Create an account at [app.keeperhub.com](https://app.keeperhub.com)
2. Your organization's Turnkey wallet is provisioned automatically once your email is verified. Open the Wallet tab to see its address
3. Fund your wallet with ETH on the network you want to use (start with Sepolia -- it's free)
4. Build a workflow with the visual builder or the AI assistant
5. Test with a manual trigger before turning on automated scheduling
6. Watch the run logs to make sure everything behaves

The [Quick Start Guide](/getting-started/quickstart) walks through this in detail.

### Do I need to know how to code?

No. The visual builder covers most automation patterns with drag-and-drop nodes -- triggers, actions, conditions, loops. You can also just describe what you want in plain English and the AI assistant will generate a workflow for you.

If you do need custom logic, the [Code Plugin](/plugins/code) runs JavaScript in a sandbox. And if you want full programmatic control, there's a [REST API](/api) and an [MCP server](/ai-tools/mcp-server) for managing workflows from code or AI agents.

### What blockchains does KeeperHub support?

KeeperHub supports a range of EVM chains, including Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, and others, plus their testnets (Sepolia, Base Sepolia, and more). The live, authoritative list is always available from `GET /api/chains`. Gas defaults are applied automatically per chain; L2s like Base and Arbitrum use lower gas multipliers since their estimates tend to be tighter.

Some protocol plugins only work on certain chains. Ajna is Base-only, Sky converters are Ethereum-only, and so on. Check each plugin's docs for specifics.

### What DeFi protocols does KeeperHub integrate with?

There are dedicated plugins for [Aave V3](/plugins/aave-v3) (lending/borrowing), [Morpho](/plugins/morpho) (lending), [Uniswap](/plugins/uniswap) (DEX/liquidity), [CoW Swap](/plugins/cowswap) (MEV-protected orders), [Pendle](/plugins/pendle) (yield tokenization), [Sky](/plugins/sky) (savings/converters), [Ajna](/plugins/ajna) (liquidation), and [Safe](/plugins/safe) (multisig monitoring).

You can also interact with any smart contract through the [Web3 plugin](/plugins/web3) -- just provide a contract address and the ABI is fetched automatically, including for proxy contracts.

---

## Wallet and funds

### How does the wallet work? Do I need to bring my own?

Your organization gets a [Turnkey wallet](/wallet-management/turnkey) automatically once your email is verified, so there's nothing to set up. Turnkey generates and holds the private key inside a secure hardware enclave (TEE), and signing during workflow execution happens automatically.

Read-only operations (checking balances, reading contracts, monitoring events) don't require any ETH. Write operations (transfers, contract calls) go through your Turnkey wallet and need ETH for gas on the target network.

### Who controls my funds? Can KeeperHub or Turnkey access my wallet without permission?

Your Turnkey wallet's private key is generated and stored inside a secure hardware enclave and never leaves it during normal operation. Signing requests are authenticated and executed within the enclave, so KeeperHub can only trigger the transactions your workflows define, and KeeperHub employees can't move your funds.

The tradeoff is that you're trusting Turnkey's enclave infrastructure to be available when your workflows need to sign transactions. If it's unavailable, write operations won't execute until it recovers.

### How do I fund my wallet?

Transfer ETH to your Turnkey wallet address on the network you want to use. The address is the same across all EVM networks -- you can find it in the Wallet tab.

Start on Sepolia. You can get free test ETH from public faucets and experiment without risking real money.

### Can I export my private key?

Yes. Turnkey supports private key export. Use the Export Key feature in the Wallet tab to retrieve your key if you need to migrate to another wallet solution.

---

## Security and trust

### Is KeeperHub safe for production use with real funds?

Yes, KeeperHub is built for production use -- automatic gas estimation with safety buffers, transaction retries, nonce management, secure-enclave wallet security.

That said, some things are worth doing:

- Test on Sepolia before switching to mainnet
- Use condition nodes to check onchain state before write operations
- Keep an eye on your wallet balance and set spending caps
- Check run logs regularly

### Can KeeperHub employees see my workflows or data?

API keys are hashed (SHA256) before storage -- only the prefix is kept for identification. Wallet private keys are held in Turnkey's secure enclaves, not stored by KeeperHub.

Workflow configurations and execution logs are stored in KeeperHub's database because the platform needs them to run your workflows and show you debugging info. So yes, that data exists on KeeperHub's infrastructure.

### What happens to pending transactions during a platform outage?

Transactions already submitted to the blockchain keep processing -- they don't depend on KeeperHub once they're on the network. Scheduled workflows that would have fired during an outage won't run until the platform recovers. If you're running time-critical automations (liquidation protection, for instance), consider redundant monitoring through other channels.

### What data does KeeperHub collect?

Account info, workflow configurations (node types, contract addresses, parameters, conditions), and execution logs (inputs, outputs, transaction hashes, gas usage). The platform needs this data to run workflows and provide analytics. API keys are hashed before storage, and wallet private keys are held in Turnkey's secure enclaves.

---

## Workflows and execution

### What happens if a workflow fails mid-execution?

Blockchain transactions are irreversible. If step 4 fails, whatever transactions steps 1-3 already confirmed on-chain can't be rolled back. KeeperHub records the status of every step in the [Runs panel](/keeper-runs/overview) with full context -- inputs, outputs, transaction hashes, error messages.

Failed steps are retried with exponential backoff. To reduce risk: test on Sepolia first, use condition nodes to validate state before write operations, and set up notifications so you always hear about failures.

### What are the execution limits?

| Limit | Value |
|-------|-------|
| API rate limit (authenticated) | 100 requests/minute |
| API rate limit (unauthenticated) | 10 requests/minute |
| Direct Execution API | 60 requests/minute per API key |
| Code Plugin timeout | 1-120 seconds (default 60) |
| Batch Read Contract | 5,000 total calls per execution |
| Batch size per RPC request | 1-500 (default 100) |

### How does gas estimation work?

KeeperHub calls `eth_estimateGas` and applies a multiplier per chain:

- Ethereum and Polygon: 2.0x normally, 2.5x for time-sensitive triggers (events, webhooks)
- Base and Arbitrum: 1.5x normally, 2.0x for time-sensitive triggers

You can override the gas limit on any action node in its Advanced section. Gas pricing (base fee, priority fee) is handled automatically. See [Gas Management](/wallet-management/gas) for more.

### How does the AI workflow builder work?

Click "Ask AI" at the bottom of the workflow canvas and describe what you want -- for example, "Monitor my vault health every 15 minutes and send a Telegram alert if collateral drops below 150%." The AI generates a workflow with triggers, actions, and conditions that you can review and tweak before turning it on.

You can also use this programmatically through the [MCP server's](/ai-tools/mcp-server) `ai_generate_workflow` tool.

### How do I pass data between workflow steps?

Each node's output is available to downstream nodes through template references: `{{@nodeId:Label.field}}`. So if a "Check Balance" node outputs a balance, a condition node downstream can reference `{{@checkBalance:Check Balance.balance}}`. These references work in notification messages, condition expressions, and action parameters. See [Core Concepts](/intro/concepts) for the full syntax.

### Does KeeperHub handle token approvals automatically?

No. You need to add an "Approve ERC20 Token" node before any write operation that requires a token allowance -- swaps, lending deposits, etc. There's also a "Check ERC20 Allowance" node if you want to verify existing approvals first.

### Can AI agents use KeeperHub autonomously?

Yes. The [MCP server](/ai-tools/mcp-server) exposes more than 30 tools that let AI agents create, trigger, run, and monitor workflows programmatically. There's also a Claude Code plugin for building workflows from the terminal.

---

## MCP and AI agent setup

### What is the MCP server?

The KeeperHub [MCP server](/ai-tools/mcp-server) lets AI agents (Claude, custom agents, etc.) create, run, and monitor workflows over the [Model Context Protocol](https://modelcontextprotocol.io). It exposes more than 30 tools covering workflow CRUD, execution, plugin discovery, protocol actions, and integration management.

### How do I set up the MCP server?

The fastest way is to connect directly to KeeperHub's hosted MCP server:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Then run `/mcp` inside Claude Code and authorize via browser. No CLI or plugin installation needed.

### How do I connect Claude Code to KeeperHub?

**Option A (remote, no install):**

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Run `/mcp` in Claude Code to authorize via browser.

**Option B (plugin with local CLI):**

```bash
/plugin marketplace add KeeperHub/claude-plugins
/plugin install keeperhub@keeperhub-plugins
```

Restart Claude Code so the plugin's commands register, then sign in:

```bash
/keeperhub:login
```

Verify with `/keeperhub:status`.

### Claude Code says "Login expired, please run /login". Is my KeeperHub session expired?

That message is about your Claude account, and `/login` is a Claude Code command. Run `/login` inside Claude Code to sign back in.

Your KeeperHub connection is separate. Check it with `/keeperhub:status`, and re-authorize it with `/mcp` (remote MCP) or `/keeperhub:login` (plugin).

### What's the difference between `kh_` and `wfb_` API keys?

`kh_` keys are organization-scoped -- used for the REST API, MCP server, and Claude Code plugin. Create them in Settings > API Keys > Organisation tab. `wfb_` keys are user-scoped and used for webhook triggers. Most of the time you want a `kh_` key.

### Can I run the MCP server for remote agents (not just local)?

Yes. Set the `PORT` and `MCP_API_KEY` environment variables to enable HTTP/SSE mode. Remote agents connect via `GET /sse` for the event stream and `POST /message` for commands. All requests require `Authorization: Bearer <MCP_API_KEY>`.

---

## API and integrations

### Is there an API?

Yes. The REST API at `app.keeperhub.com/api` covers workflow CRUD, execution, analytics, and integration management. Authenticate with API keys (Bearer token). See the [API docs](/api) for endpoints.

### What notification channels are supported?

[Discord](/plugins/discord) (webhook URL), [Slack](/plugins/slack) (bot token), [Telegram](/plugins/telegram) (bot token), [SendGrid email](/plugins/sendgrid), and generic [webhooks](/plugins/webhook). Set up connections once in account settings and reuse them across workflows.

### Can I export or version-control my workflows?

You can download any workflow as JSON from the toolbar or via `GET /api/workflows/{workflowId}/download`. SDK code generation is available at `GET /api/workflows/{workflowId}/code`. Duplication works through the API or the Hub.

There's no built-in version history or CI/CD integration yet. If you need that, the MCP server's `create_workflow` and `update_workflow` tools can be wired into a custom GitOps pipeline.

---

## Account and organization

### How do teams and organizations work?

You can create organizations, invite team members via email, and share workflows within the org. Organizations have three roles (owner, admin, and member) that gate sensitive wallet and security actions, while workflow collaboration is shared across all members. See [Access Control](/users-teams-orgs/permissions) for the breakdown.

See [Organizations](/users-teams-orgs/organizations) for details.

### What happens if I lose access to my account?

Reset your password with a one-time code sent to your email. OAuth users (Google, GitHub) go through their provider's recovery flow.

### What happens if I delete my account?

Deletion is a soft delete -- your data is preserved but the account is deactivated and all sessions are invalidated. You can reactivate by contacting an administrator. Export your workflow definitions before deleting if you want to keep them.

---

## Comparison and migration

### How does KeeperHub compare to OpenZeppelin Defender, Gelato, or Chainlink Automation?

The main differences: KeeperHub has a visual no-code builder (vs YAML/code), AI-assisted workflow generation, and managed non-custodial wallets via Turnkey secure enclaves (vs self-managed keys). There are dedicated migration guides for [Defender](/guides/defender-migration) and [Gelato](/guides/gelato-migration) with feature mapping tables.

OpenZeppelin Defender shuts down July 1, 2026. Gelato Web3 Functions shut down March 31, 2026.

### When should I use a custom keeper bot instead?

A custom bot makes more sense when you need sub-second latency (MEV, arbitrage), complex stateful logic that doesn't fit a DAG, specific infrastructure requirements (co-located servers, custom RPC nodes), or zero third-party dependencies.

KeeperHub makes more sense when you want to skip building infrastructure, need to iterate on automation logic quickly, want non-technical team members involved, or need multi-chain support without managing separate deployments.

### Can I use custom RPC endpoints?

Yes. In Settings, set a primary and fallback RPC URL per chain. Your custom endpoints replace the platform defaults. Delete the preference to revert.
