---
title: "Node Types"
description: "Overview of trigger, action, and condition nodes available in KeeperHub workflows."
---

# Node Types Overview

KeeperHub workflows are built from three types of nodes: Triggers, Actions, and Conditions. Each node type serves a specific purpose in your automation.

## Trigger Nodes

Triggers determine when your workflow executes. Every workflow must start with a trigger node.

### Scheduled Trigger
Run your workflow at regular intervals.

**Configuration:**
- Interval selection (every 5 minutes, hourly, daily, weekly, custom cron)
- Timezone settings

**Use Cases:** Regular balance checks, periodic report generation, scheduled maintenance tasks

### Webhook Trigger
Run your workflow when an external service sends an HTTP request.

**Configuration:**
- Unique webhook URL (auto-generated)
- Optional authentication headers

**Use Cases:** Integration with external systems, CI/CD pipelines, third-party alerts

### Event Trigger
Run your workflow when a specific blockchain event is detected.

**Configuration:**
- Contract address
- Event signature
- Network selection

**Use Cases:** React to token transfers, smart contract state changes, on-chain activity

### Manual Trigger
Run your workflow only when you click the Run button.

**Configuration:**
- No additional setup required

**Use Cases:** Testing, one-time operations, on-demand executions

### Block Trigger
Run your workflow every N blocks on a chosen network.

**Configuration:**
- Network selection
- Block interval (1 = every block, 10 = every 10th block)

**Use Cases:** Block-cadence monitoring, per-block price or state checks

## Action Nodes

Actions perform operations in your workflow. Connect multiple actions to create complex automations.

### Web3 Actions

#### Check Balance
Monitor wallet or token balances on any supported network.

**Configuration:**
- Network (Ethereum Mainnet, Sepolia, etc.)
- Wallet address to monitor
- Token contract (optional, for ERC-20 tokens)

**Output:** Current balance value for use in conditions

#### Read Contract
Call read-only functions on smart contracts.

**Configuration:**
- Network and contract address
- Function to call (auto-populated from ABI)
- Function parameters

**Output:** Function return values

#### Write Contract
Execute state-changing functions on smart contracts.

**Configuration:**
- Network and contract address
- Function to call
- Function parameters
- Gas settings

**Requirements:** Funded Turnkey wallet for gas fees

#### Transfer Funds
Send ETH or tokens to another address.

**Configuration:**
- Network
- Recipient address
- Amount
- Token contract (optional)

**Requirements:** Funded Turnkey wallet

### Notification Actions

#### Send Email
Send email notifications when workflow conditions are met.

**Configuration:**
- Connection (email provider)
- Recipient address(es)
- Subject and message content
- Dynamic variables from workflow

#### Send Discord Message
Post messages to Discord channels.

**Configuration:**
- Connection (Discord webhook)
- Message content
- Dynamic variables from workflow

#### Send Slack Message
Post messages to Slack channels.

**Configuration:**
- Connection (Slack bot token)
- Channel selection
- Message content

#### Send Telegram Message
Send messages to Telegram chats and channels.

**Configuration:**
- Connection (Telegram bot token)
- Chat ID (numeric ID or @username)
- Message content
- Parse mode (plain text or MarkdownV2)

**Output:** Success status, message ID

### Integration Actions

#### Send Webhook
Send HTTP requests to external services.

**Configuration:**
- URL (HTTPS required)
- HTTP method (GET, POST, etc.)
- Headers
- JSON payload with dynamic variables

## Condition Nodes

Conditions evaluate data from previous nodes and determine which path the workflow takes.

### Low Balance Condition
Check if a balance is below a specified threshold.

**Configuration:**
- Threshold value
- Comparison operator

**Outputs:** Two paths - condition met (true) or not met (false)

### Value Comparison
Compare any value against a target.

**Configuration:**
- Input value (from previous node)
- Operator (equals, not equals, greater than, less than, contains)
- Comparison value

### Custom Condition
Combine multiple conditions with logical operators.

**Configuration:**
- Multiple condition rules
- AND/OR logic between rules

## Choosing the Right Nodes

| Goal | Recommended Nodes |
|------|-------------------|
| Monitor wallet balance | Scheduled Trigger + Check Balance + Condition + Notification |
| React to blockchain events | Event Trigger + Action |
| Automate DeFi operations | Scheduled Trigger + Read Contract + Condition + Write Contract |
| Alert on contract changes | Scheduled Trigger + Read Contract + Condition + Send Discord |
| Integrate with external systems | Webhook Trigger + Action + Send Webhook |
