---
title: "Node Configuration"
description: "Complete guide to configuring workflow nodes - triggers, actions, conditions, and connections."
---

# Node Configuration

This guide covers how to configure nodes in the KeeperHub workflow builder.

## Configuration Panel

Click any node on the canvas to open its configuration panel on the right side of the screen. The panel shows all available settings for that node type.

### Required Fields

Fields marked with an asterisk (*) are required. The workflow cannot run until all required fields are completed.

### Common Fields

All nodes share these configuration options:

| Field | Description |
|-------|-------------|
| Label | Display name shown on the node (e.g., "Check Balance") |
| Description | Optional notes about what this node does |
| Enabled | Toggle to activate or deactivate this node |

## Trigger Configuration

### Scheduled Trigger

| Field | Description |
|-------|-------------|
| Interval | How often the workflow runs |
| Options | Every 5 minutes, 15 minutes, hourly, daily, weekly, or custom cron |

**Custom Cron**: Enter a cron expression for precise scheduling (e.g., `0 9 * * 1-5` for weekdays at 9 AM).

### Webhook Trigger

| Field | Description |
|-------|-------------|
| Webhook URL | Auto-generated URL to trigger this workflow |
| Authentication | Optional API key requirement |

Copy the webhook URL and configure your external service to POST to it.

### Event Trigger

| Field | Description |
|-------|-------------|
| Network * | Blockchain network to monitor |
| Contract Address * | Smart contract to watch for events |
| Event | Specific event to listen for (populated from ABI) |

### Manual Trigger

No additional configuration needed. Click the Run button to execute.

### Block Trigger

| Field | Description |
|-------|-------------|
| Network * | Blockchain network to watch |
| Block Interval * | Fire the workflow every N blocks (1 = every block, 10 = every 10th block) |
| Skip if the previous run is still running | Off by default. EVM networks only. While a run of this workflow is still pending or running, a block that fires does not start a run. |
| Also run when a slot is missed | Off by default. Ethereum Mainnet, Sepolia and Hoodi, Block Interval 1 only. When no block arrives 4 seconds into a slot, the workflow runs anyway. |

#### Skip if the previous run is still running

Use it when a run must not overlap the one before it, for example a keeper that sends a transaction and waits for its receipt. Blocks that fire while a run is going are skipped:

- The run history shows one Skipped row for each run that blocked others, with a count of the times it skipped: once per block or missed slot, even if KeeperHub receives the same block twice (a retry) within 2 minutes.
- Skipped rows are not billed and never count toward or reset failure alerts.
- Runs started through a listed workflow's public call endpoint do not block it: callers of a listed workflow cannot stop your trigger.
- A run that started more than 30 minutes ago and has not finished a step in the last 30 minutes (the platform's stale-run limit) no longer blocks new runs.
- If the platform cannot run the check (it cannot record the run before dispatching it), the block is skipped rather than run unchecked; no Skipped row is written for it.
- A run that waits more than 5 minutes to start and is timed out by the platform is not started later.
- Through the API, `true` and `"true"` both turn it on.
- A run that sent a transaction but is still waiting for its receipt (its transaction may still be pending) does not block the next run, so the next run may send the same action again; check onchain state before sending.
- The switch works per workflow, not per wallet: runs of other workflows that use the same wallet do not block this one.

#### Also run when a slot is missed

Ethereum produces at most one block per 12-second slot, and sometimes a slot stays empty. With this switch on, KeeperHub checks 4 seconds into each slot, and if no block has arrived it runs the workflow anyway.

- A run starts some seconds after its trigger: with the Standard start priority often more than one 12-second slot, with Low latency usually under a second when a pre-warmed runner is free. Either way a missed-slot run is an extra run that carries the next slot's data, not a guaranteed send in that slot.
- At most one run per slot: if the slot's block arrives late, after the missed-slot run, it does not start a second run. If a late block is replaced by a block in the next slot with the same number (a reorg), that next slot still gets its run.
- With "Skip if the previous run is still running" also on, a missed-slot run is often recorded as Skipped, because the previous block's run is still going.
- Missed-slot runs are best effort. They pause while blocks reach KeeperHub more than 4 seconds after their slot starts, and resume on their own once blocks are on time again. They also stop after 4 empty slots in a row, since that usually means a lagging node rather than missed slots, and start again with the next block that arrives.
- The switch is saved on any network and at any interval, but only takes effect on Ethereum Mainnet, Sepolia and Hoodi with Block Interval 1. Through the API, `true` and `"true"` both turn it on.

While this switch takes effect, every run carries these trigger fields; they are absent when it does not (another network, or a Block Interval other than 1). On a missed-slot run the usual block fields (`blockNumber`, `blockHash`, `blockTimestamp`, `parentHash`) describe the latest block on the chain, which is the block before the empty slot. After a reconnect, blocks that are caught up carry the fields of their own (past) slot: turn on "Skip if the previous run is still running" so a burst of them does not start overlapping runs, and compare `slotTimestamp` with the current time to spot stale blocks.

| Field | Description |
|-------|-------------|
| `missedSlot` | `true` when no block had arrived 4 seconds into the slot (a late block may still land; it does not start a second run), `false` on a run fired by a block |
| `slotTimestamp` | Start of the slot that fired the run (`targetSlot - 1`), in Unix seconds |
| `targetSlot` | Beacon chain slot number of the slot after it |
| `targetSlotTimestamp` | Start of that next slot, in Unix seconds |

Pick them from the trigger in any step's template picker. To act once per slot, deduplicate on `targetSlot`, not `blockNumber`: a missed-slot run reports the same `blockNumber` as the run of the block before it, and two missed slots in a row report the same one too.

## Web3 Node Configuration

### Check Balance

| Field | Description |
|-------|-------------|
| Service | Web3 |
| Connection * | Your connected wallet (for signing if needed) |
| Network * | Ethereum Mainnet, Sepolia, or other supported network |
| Address * | Wallet address to check balance for |

### Read Contract

| Field | Description |
|-------|-------------|
| Service | Web3 |
| Connection | Your connected wallet |
| Network * | Target blockchain network |
| Contract Address * | Smart contract address |
| Function * | Read function to call (auto-populated from ABI) |
| Parameters | Function input parameters |

KeeperHub automatically fetches the contract ABI from block explorers. For proxy contracts, it detects the proxy pattern and fetches the implementation ABI automatically. Supported proxy standards include EIP-1967, EIP-1822 (UUPS), OpenZeppelin Transparent Proxy, EIP-1167 (minimal proxy), and Gnosis Safe. For EIP-2535 Diamond contracts, KeeperHub queries the Diamond Loupe interface to discover all facets and combines their ABIs into a single unified interface.

### Write Contract

| Field | Description |
|-------|-------------|
| Service | Web3 |
| Connection * | Wallet connection for signing |
| Network * | Target blockchain network |
| Contract Address * | Smart contract address |
| Function * | Write function to execute |
| Parameters | Function input parameters |
| Gas Limit | Optional gas limit override |

**Important**: Write operations require ETH in your Turnkey wallet for gas fees.

### Transfer Funds

| Field | Description |
|-------|-------------|
| Service | Web3 |
| Connection * | Wallet to send from |
| Network * | Target network |
| To Address * | Recipient address |
| Amount * | Amount to transfer |
| Token | Native (ETH) or token contract address |

## Notification Node Configuration

### Send Email

| Field | Description |
|-------|-------------|
| Connection * | Email provider connection |
| To * | Recipient email address(es) |
| Subject | Email subject line |
| Message | Email body content |

### Send Discord Message

| Field | Description |
|-------|-------------|
| Connection * | Discord webhook connection |
| Message * | Message content to send |

### Send Slack Message

| Field | Description |
|-------|-------------|
| Connection * | Slack bot token connection |
| Channel | Target channel |
| Message * | Message content to send |

### Send Telegram Message

| Field | Description |
|-------|-------------|
| Connection * | Telegram bot connection |
| Chat ID * | Numeric chat ID or @channelusername |
| Message * | Message content to send |
| Parse Mode | None (plain text) or MarkdownV2 |

## Condition Node Configuration

### Low Balance Condition

| Field | Description |
|-------|-------------|
| Threshold * | Balance value to compare against |
| Operator | Less than, less than or equal |

### Value Comparison

| Field | Description |
|-------|-------------|
| Input | Value from previous node output |
| Operator * | Comparison operator |
| Value * | Target value to compare |

**Available Operators:**
- Equals (==)
- Not equals (!=)
- Greater than (>)
- Greater than or equal (>=)
- Less than (<)
- Less than or equal (<=)
- Contains (for strings)

## Managing Connections

Connections store credentials for external services. Set them up before configuring nodes that require them.

### Adding a Connection

1. Open Settings from the user menu
2. Under Organization, select **Connections**
3. Click **Add Connection**
4. Choose the connection type
5. Enter the required credentials
6. Save the connection

### Connection Types

| Type | Required Information |
|------|---------------------|
| Web3 Wallet | Wallet address (Turnkey wallet auto-connected) |
| Email | Provider API key |
| Discord | Webhook URL |
| Slack | Bot token (starts with `xoxb-`) |
| Telegram | Bot token from BotFather |
| Webhook | URL and authentication headers |

### Using Connections in Nodes

When configuring a node:
1. Select the **Connection** field
2. Choose from your saved connections
3. The connection status shows as a green checkmark if valid

## Dynamic Variables

Reference data from earlier nodes in notification messages, condition expressions, and action parameters using template references:

```
{{@nodeId:Label.field}}
```

For example, a Check Balance node labeled "Check Balance" exposes its result as `{{@checkBalance:Check Balance.balance}}`. See [Templating](/workflows/templating) for the full syntax and available fields.

**Example Message:**
```
Balance Alert: {{@checkBalance:Check Balance.address}} has {{@checkBalance:Check Balance.balance}} ETH
```

## Enabling and Disabling Nodes

Each node has an **Enabled** toggle:
- **Enabled**: Node executes when the workflow runs
- **Disabled**: Node is skipped during execution

This allows you to temporarily disable parts of a workflow without deleting them.

## Deleting Nodes

Click the **Delete** button at the bottom of the configuration panel to remove a node. This also removes all connections to and from that node.
