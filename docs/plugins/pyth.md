---
title: "Pyth Network Plugin"
description: "Real-time oracle price feeds, confidence intervals, and binary update data (VAA) from Pyth Network for multi-chain Web3 workflows."
---

# Pyth Network Plugin

Query Pyth Network's Hermes REST API for real-time price feeds, confidence intervals, exponential moving averages, and binary VAA update payloads.

## Actions

| Action | Description |
|--------|-------------|
| Get Latest Price | Fetch price float, confidence interval, EMA price, and publish timestamp for a symbol or Feed ID |
| Get Price Update Data (VAA) | Fetch binary VAA update bytes (`hex` or `base64`) to submit to on-chain `updatePriceFeeds(bytes[])` |
| Search Price Feeds | Search Pyth price feed catalog by symbol or asset class (Crypto, Equity, FX, Metals, Commodities) |

## Setup

1. In **Settings > Organization > Connections**, click **+ Add Connection** and select **Pyth Network**.
2. Enter your **Pyth API Key** (`PYTH_API_KEY`) obtained from Pyth Network / Douro Labs.
3. (Optional) Customize the **Hermes Endpoint URL** if using a private provider (defaults to `https://hermes.pyth.network`).

## Get Latest Price

Fetch real-time price data for a symbol (e.g. `ETH/USD`, `BTC/USD`, `SOL/USD`) or 64-character Pyth price feed hex ID.

**Inputs:** Feed ID or Symbol (supports `{{NodeName.field}}` variables)

**Outputs:** `price`, `priceString`, `confidence`, `expo`, `publishTime`, `feedId`, `emaPrice`, `emaConfidence`, `success`, `error`

**When to use:** Branch on real-time price thresholds before calling swaps, liquidations, or debt rebalance contract calls.

**Example workflow:**
```
Schedule (every 5 min)
  -> Pyth: Get Latest Price (ETH/USD)
  -> Condition: price < 3000
  -> Web3: Write Contract (rebalance vault)
```

## Get Price Update Data (VAA)

Fetch binary VAA update bytes for one or more price feeds.

**Inputs:** Price Feed IDs / Symbols, Encoding (`hex` or `base64`)

**Outputs:** `updateData` (array of hex/base64 strings), `encoding`, `feedIds`, `updateDataCount`, `success`, `error`

**When to use:** Prepare on-chain Pyth price update payloads before invoking smart contract functions that require fresh Pyth updates (`updatePriceFeeds(bytes[])`).

## Search Price Feeds

Search Pyth price feed catalog by query string or asset class.

**Inputs:** Search Query, Asset Type (`crypto`, `equity`, `fx`, `commodities`, `metal`, `crypto_redemption_rate`, `crypto_index`)

**Outputs:** `feeds` (array of feed metadata objects), `matchingCount`, `returnedCount`, `success`, `error`
