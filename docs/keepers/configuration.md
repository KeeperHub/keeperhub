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
