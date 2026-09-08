---
title: "Core Concepts"
description: "Learn about Workflows, Nodes, Connections, and other KeeperHub fundamentals for blockchain automation."
---

# Core Concepts

Understanding these core concepts will help you get the most out of KeeperHub.

## Workflows

Workflows are visual automations that you build by connecting nodes on a canvas. Each workflow represents a complete automation - from trigger to actions.

**Key characteristics:**
- Visual, node-based design
- Automatic or manual execution
- Conditional branching for complex logic
- Shareable via the Hub

## Nodes

Nodes are the building blocks of workflows. Each node performs a specific function.

### Trigger Nodes

Every workflow starts with a trigger that determines when it runs:

- **Scheduled**: Run at intervals (every 5 minutes, hourly, daily)
- **Webhook**: Run when an external service calls your workflow URL
- **Event**: Run when a blockchain event is detected
- **Block**: Run at blockchain block intervals on a specific chain
- **Manual**: Run only when you click the Run button

### Action Nodes

Actions perform the actual work in your workflow:

- **Web3 Actions**: Check Balance, Read Contract, Write Contract, Transfer Funds
- **Notification Actions**: Send Email, Send Discord Message, Send Slack Message
- **Integration Actions**: Send Webhook, custom HTTP requests

### Condition Nodes

Conditions evaluate data and create branching paths:

- **Low Balance Condition**: Check if balance is below threshold
- **Value Comparison**: Compare any value against a target
- **Custom Logic**: Combine conditions with AND/OR operators

## Connections

Connections store credentials for external services. Set up connections once and reuse them across workflows.

**Connection types:**
- **Web3**: Wallet connections for blockchain operations
- **Email**: Email provider configuration
- **Discord**: Webhook URLs for Discord channels
- **Slack**: Bot token
- **Telegram**: Bot token from BotFather
- **Webhook**: Custom HTTP endpoint credentials

## Workflow Runs

Each time a workflow executes, it creates a run with detailed logging:

- **Status**: Pending, Running, Completed, Failed, Cancelled
- **Node Outputs**: Results from each node in the workflow
- **Timing**: Start time, duration, completion time
- **Errors**: Detailed error messages if something fails

## The Hub

The Hub is a marketplace for workflow templates:

- **Browse**: Discover workflows shared by the community
- **Import**: Copy workflows to your account
- **Share**: Publish your workflows for others to use

## AI Assistant

KeeperHub includes an AI assistant to help you build workflows:

- Describe what you want in plain language
- The AI suggests nodes and configurations
- Review and customize the generated workflow

Access the AI via the "Ask AI..." input at the bottom of the canvas.

## Turnkey Wallet

Every KeeperHub organization includes a Turnkey wallet:

- **Automatic provisioning**: Created once your email is verified
- **Secure custody**: Private keys are generated and held inside secure hardware enclaves (TEEs)
- **Key export**: Export your private key at any time to migrate elsewhere
- **Funding**: Top up with ETH to enable gas-consuming operations
- **Management**: View balance, withdraw funds, and export your key via Settings > Organization > Wallets

## Networks

KeeperHub supports a range of EVM chains, including:

- **Ethereum Mainnet**: Production network for real transactions
- **Base, Arbitrum, Optimism, Polygon**: Layer 2 and sidechain networks with lower gas fees
- **BNB Chain, Avalanche, and others**: Additional supported mainnets
- **Testnets** (Sepolia, Base Sepolia, and more): For development with free test tokens

The authoritative, up-to-date list is available from `GET /api/chains`.

Always test workflows on a testnet before deploying to Mainnet.
