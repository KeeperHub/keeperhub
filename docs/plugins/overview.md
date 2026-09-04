---
title: "Plugins"
description: "Available workflow plugins for blockchain operations, notifications, and integrations."
---

# Plugins

Plugins provide the actions available in your workflows. Each plugin adds one or more actions that you can drag onto the workflow canvas and configure.

## Available Plugins

| Plugin | Category | Actions | Credentials Required |
|--------|----------|---------|---------------------|
| [Web3](/plugins/web3) | Blockchain | Balance checks, contract reads/writes, transfers, calldata decoding, risk assessment | Wallet (for writes) |
| [Code](/plugins/code) | Code | Execute custom JavaScript in a sandboxed VM | None |
| [Math](/plugins/math) | Math | Aggregation operations (sum, count, average, median, min, max, product) | None |
| [Safe](/plugins/safe) | Protocol | Safe multisig owners, threshold, nonce, module status, pending transactions | API key (for pending txs) |
| [Aave V3](/plugins/aave-v3) | Protocol | Supply, borrow, repay, collateral management, health factor monitoring | Wallet (for writes) |
| [Aave V4](/plugins/aave-v4) | Protocol | Hub-and-Spoke supply, borrow, repay, collateral management via the Lido Spoke | Wallet (for writes) |
| [Aerodrome](/plugins/aerodrome) | Protocol | Pool reserves, swap quotes, ve(3,3) voting, gauge management, AERO token operations | Wallet (for writes) |
| [Ajna](/plugins/ajna) | Protocol | Liquidation keeper operations, vault rebalancing, buffer management | Wallet (for writes) |
| [Chainlink](/plugins/chainlink) | Protocol | Oracle price feeds -- latest prices, round data, decimals, feed metadata | None |
| [Chronicle](/plugins/chronicle) | Protocol | Verifiable oracle price feeds with Schnorr signature verification | None (whitelisted caller) |
| [Compound V3](/plugins/compound) | Protocol | Supply, withdraw, base/collateral/borrow balance monitoring | Wallet (for writes) |
| [CoW Swap](/plugins/cowswap) | Protocol | Order pre-signing, fill monitoring, conditional orders, order cancellation | Wallet (for writes) |
| [Curve](/plugins/curve) | Protocol | Pool swaps, LP management, virtual prices, CRV token operations | Wallet (for writes) |
| [Ethena](/plugins/ethena) | Protocol | sUSDe staking vault, cooldown/unstake, USDe and ENA balances | Wallet (for writes) |
| [Frax Ether V2](/plugins/frax-ether-v2) | Protocol | Liquid staking on Ethereum mainnet. Mint frxETH 1:1 from native ETH, or mint and stake directly into sfrxETH in one transaction | Wallet (for writes) |
| [Lido](/plugins/lido) | Protocol | Wrap/unwrap stETH to wstETH, exchange rates, balances across Ethereum, Base, Sepolia | Wallet (for writes) |
| [Morpho](/plugins/morpho) | Protocol | Supply, borrow, repay, liquidate, collateral management, position tracking, market monitoring | Wallet (for writes) |
| [Pendle](/plugins/pendle) | Protocol | Yield tokenization, market data, PT/YT/SY balances, mint/redeem | Wallet (for writes) |
| [Rocket Pool](/plugins/rocket-pool) | Protocol | rETH exchange rate, balances, total supply, ETH deposits and withdrawals | Wallet (for writes) |
| [Sky](/plugins/sky) | Protocol | USDS savings and staking vaults, token balances, approvals, DAI/MKR converters | Wallet (for writes) |
| [Spark](/plugins/spark) | Protocol | Lending, borrowing, sDAI savings, health factor monitoring | Wallet (for writes) |
| [Superfluid](/plugins/superfluid) | Protocol | Open/update/close money streams, distribution pools, SuperToken wrap/unwrap | Wallet (for writes) |
| [Uniswap](/plugins/uniswap) | Protocol | Pool discovery, LP position details, position NFT management | Wallet (for writes) |
| [Wrapped](/plugins/wrapped) | Protocol | Wrap/unwrap a chain's native token into its wrapped ERC-20 form | Wallet (for writes) |
| [Yearn V3](/plugins/yearn-v3) | Protocol | ERC-4626 yield vaults, strategy monitoring, profit tracking | Wallet (for writes) |
| [Discord](/plugins/discord) | Notifications | Send messages to channels | Webhook URL |
| [Slack](/plugins/slack) | Notifications | Send messages to channels | Bot token |
| [Telegram](/plugins/telegram) | Notifications | Send messages to chats | Bot token |
| [SendGrid](/plugins/sendgrid) | Notifications | Send emails | API key |
| [Webhook](/plugins/webhook) | Integrations | Send HTTP requests to external services | None |
| [Hyperliquid](/plugins/hyperliquid) | Data | Read-only Info API queries: clearinghouse state, vault details, validators, funding history, spot deploy state, referrals, sub-accounts, active asset data | None |
| [Blockscout](/plugins/blockscout) | Data | Read-only block explorer queries: address balance, transaction details, token info | None (optional instance URL/API key) |
| [Robinhood](/plugins/robinhood) | Data | Read-only stock-token reads on Robinhood Chain: price, holder position in share terms, market/trading status | None |

## How Plugins Work

1. **Add an action** -- Drag a plugin action from the action panel onto your workflow canvas
2. **Configure inputs** -- Set parameters in the right-side panel. Use `{{NodeName.field}}` to reference outputs from previous steps
3. **Connect nodes** -- Wire the action into your workflow flow using edges
4. **Run** -- Execute the workflow. Each action runs in sequence following the edges

## Plugin Categories

### Blockchain (Web3)

Core on-chain operations: reading balances, calling smart contracts, transferring tokens, and security analysis. Read-only actions work without a wallet. Write actions require a connected Turnkey wallet.

### Code

Execute custom JavaScript in a sandboxed VM environment with access to workflow data via template variables. Use for data transformation, aggregation, external API calls, and complex conditional logic. No credentials required.

### Math

Pure computation nodes for aggregating numeric values from upstream nodes. Supports sum, count, average, median, min, max, and product operations with optional post-aggregation arithmetic. Automatically handles large integers using BigInt arithmetic to preserve precision.

### Security

Security-focused actions for transaction analysis, risk assessment, and Safe multisig monitoring. These actions use `maxRetries = 0` (fail-safe behavior) to ensure errors block execution rather than silently retrying.

### Notifications

Send alerts and messages through Discord, Slack, Telegram, email, and webhooks. Typically used as the final step in monitoring workflows to notify your team when conditions are met.

### Integrations

Connect to external services via webhooks and HTTP requests. Use these to trigger external systems, update dashboards, or integrate with third-party tools.
