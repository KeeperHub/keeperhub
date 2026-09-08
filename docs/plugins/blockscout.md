---
title: "Blockscout Plugin"
description: "Query the Blockscout block explorer REST API for address, transaction, and token data."
---

# Blockscout Plugin

Read on-chain data from any Blockscout-powered block explorer. All actions are read-only and require no credentials. Pick a chain on the action and it queries that chain's Blockscout explorer automatically.

## Actions

| Action | Description |
|--------|-------------|
| Get Address Balance | Look up the native coin balance and metadata for an address |
| Get Address Info | Fetch the full address summary including reputation and verification flags |
| Get Address Counters | Fetch activity counters (transactions, token transfers, gas usage) |
| Get Transaction | Fetch details for a transaction by hash |
| Get Token Info | Fetch metadata for an ERC-20/721/1155 token contract |

Every action takes a **Chain** input that selects which Blockscout explorer to query (defaults to Ethereum mainnet).

## Choosing a chain

Each action has a **Chain** selector backed by hosted Blockscout instances, so no connection is needed for supported chains:

| Chain | Chain ID |
|-------|----------|
| Ethereum Mainnet | 1 |
| Ethereum Sepolia | 11155111 |
| Base | 8453 |
| Base Sepolia | 84532 |
| Optimism | 10 |
| Arbitrum One | 42161 |
| Gnosis | 100 |
| Polygon | 137 |

## Setup (custom or self-hosted instances only)

For a chain not in the list above, or to use a self-hosted instance or an API key:

1. On the Blockscout node, set the **Blockscout Instance URL** (for example
   `https://gnosis.blockscout.com`)
2. Optionally add an **API Key** for higher rate limits

These are set on the action itself. Blockscout is not offered in
Settings > Organization > Connections, because the public Ethereum mainnet
instance works without a credential.

An instance URL takes precedence over the Chain selector.

## Get Address Balance

Look up the native coin balance and metadata for an account or contract address.

**Inputs:** Chain, Address (supports `{{NodeName.field}}` variables)

**Outputs:** `address`, `balance` (wei), `isContract`, `ensName`, `success`, `error`

**When to use:** Monitor a treasury or wallet balance, branch on whether an address is a contract, resolve an ENS name before notifying.

**Example workflow:**
```
Schedule (every 10 min)
  -> Get Address Balance (treasury address)
  -> Condition: balance < threshold
  -> Discord: "Treasury low: {{GetAddressBalance.balance}} wei"
```

## Get Address Info

Fetch the full Blockscout address summary in one call -- balance, exchange rate, reputation, verification, and engagement flags.

**Inputs:** Chain, Address (supports `{{NodeName.field}}` variables)

**Outputs:** `address`, `coinBalance` (wei), `exchangeRate` (USD), `isScam`, `isVerified`, `isContract`, `reputation`, `ensName`, `proxyType`, `publicTags`, `hasTokenTransfers`, `hasTokens`, `hasLogs`, `blockNumberBalanceUpdatedAt`, `success`, `error`

**When to use:** Build an address reputation or trust score, gate a workflow on whether an address is scam-flagged or a verified contract, surface ENS and balance together in one step.

**Example workflow:**
```
Manual trigger
  -> Get Address Info: {{Trigger.address}}
  -> Get Address Counters: {{Trigger.address}}
  -> Code: compute trust score from {{GetAddressInfo}} + {{GetAddressCounters}}
```

## Get Address Counters

Fetch lifetime activity counters for an address.

**Inputs:** Chain, Address (supports `{{NodeName.field}}` variables)

**Outputs:** `transactionsCount`, `tokenTransfersCount`, `gasUsageCount`, `validationsCount`, `success`, `error`

**When to use:** Measure how active or established an address is, weight an activity score, branch on whether an address has any transaction history.

**Example workflow:**
```
Webhook (address received)
  -> Get Address Counters: {{Webhook.address}}
  -> Condition: transactionsCount > 1000
  -> Discord: "Established wallet: {{GetAddressCounters.transactionsCount}} txs"
```

## Get Transaction

Fetch status and details for a transaction by hash.

**Inputs:** Chain, Transaction Hash (supports `{{NodeName.field}}` variables)

**Outputs:** `hash`, `status`, `value`, `from`, `to`, `blockNumber`, `fee`, `method`, `success`, `error`

**When to use:** Confirm a transaction succeeded before continuing, read the value or method of an observed transaction, surface fees in a report.

**Example workflow:**
```
Webhook (tx hash received)
  -> Get Transaction: {{Webhook.hash}}
  -> Condition: status == "ok"
  -> Telegram: "Tx confirmed in block {{GetTransaction.blockNumber}}"
```

## Get Token Info

Fetch metadata for a token contract.

**Inputs:** Chain, Token Address (supports `{{NodeName.field}}` variables)

**Outputs:** `address`, `name`, `symbol`, `decimals`, `totalSupply`, `type`, `holders`, `success`, `error`

**When to use:** Resolve a token symbol and decimals before formatting amounts, track total supply changes, label a token in notifications.

**Example workflow:**
```
Manual trigger
  -> Get Token Info: token address
  -> SendGrid: "{{GetTokenInfo.symbol}} supply is {{GetTokenInfo.totalSupply}}"
```
