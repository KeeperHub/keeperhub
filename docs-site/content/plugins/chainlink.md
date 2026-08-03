---
title: "Chainlink"
description: "Chainlink oracle price feeds -- read latest prices, round data, decimals, and feed metadata via AggregatorV3Interface."
---

# Chainlink

Chainlink is the industry-standard decentralized oracle network. Chainlink Price Feeds provide tamper-proof, high-quality price data for smart contracts and off-chain applications. Each price feed is a separate contract implementing the AggregatorV3Interface, deployed per trading pair (e.g., ETH/USD, BTC/USD) on multiple chains.

Unlike protocols with fixed contract addresses, each Chainlink price feed has its own address. You provide the feed contract address when configuring the workflow action. Find feed addresses at [data.chain.link](https://data.chain.link/).

Supported chains: Ethereum Mainnet, Base, Arbitrum, Optimism, Sepolia. All actions are read-only and require no credentials.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Latest Round Data | Read | No | Get the latest price, round ID, and timestamps |
| Get Round Data | Read | No | Get price and timestamps for a specific historical round |
| Get Latest Answer | Read | No | Get the latest raw price answer |
| Get Decimals | Read | No | Get the number of decimals for the feed |
| Get Description | Read | No | Get the human-readable feed description |
| Get Version | Read | No | Get the aggregator contract version |

---

## Get Latest Round Data

Get the latest price, round ID, and timestamps from a Chainlink price feed. This is the most commonly used method for reading oracle data.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Price Feed Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| roundId | uint80 | Round ID |
| answer | int256 | Price Answer |
| startedAt | uint256 | Round Started At (Unix) |
| updatedAt | uint256 | Last Updated At (Unix) |
| answeredInRound | uint80 | Answered In Round |

**When to use:** Read the current price with full round metadata, check data freshness via timestamps, detect stale feeds by comparing updatedAt with current time.

---

## Get Round Data

Get the price and timestamps for a specific historical round from a Chainlink price feed. Useful for querying past price snapshots.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Price Feed Address |
| _roundId | uint80 | Round ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| roundId | uint80 | Round ID |
| answer | int256 | Price Answer |
| startedAt | uint256 | Round Started At (Unix) |
| updatedAt | uint256 | Last Updated At (Unix) |
| answeredInRound | uint80 | Answered In Round |

**When to use:** Query historical price data for a specific round, compare prices across rounds, build TWAP calculations.

---

## Get Latest Answer

Get the latest raw price answer from a Chainlink price feed. Returns the price as a raw integer -- divide by 10^decimals for the human-readable value (e.g., for an 8-decimal USD feed, divide by 1e8).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Price Feed Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| answer | int256 | Latest Price Answer |

**When to use:** Quick price check when you only need the current value without round metadata or timestamps.

---

## Get Decimals

Get the number of decimals used by a Chainlink price feed. USD-denominated feeds typically use 8 decimals, ETH-denominated feeds use 18 decimals.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Price Feed Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| decimals | uint8 | Decimals |

**When to use:** Determine the precision of a feed before formatting prices, validate feed configuration, build dynamic price formatting logic.

---

## Get Description

Get the human-readable description of a Chainlink price feed (e.g., "ETH / USD", "BTC / USD"). Useful for display and logging.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Price Feed Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| description | string | Feed Description |

**When to use:** Label price data in dashboards, validate that a feed address matches the expected pair, include feed names in notifications.

---

## Get Version

Get the version number of a Chainlink price feed aggregator contract. Useful for compatibility checks.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Price Feed Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| version | uint256 | Aggregator Version |

**When to use:** Verify aggregator version before relying on specific features, audit deployed feed contracts, detect aggregator upgrades.

---

## Example Workflows

### Price Feed Monitor with Discord Alerts

`Schedule (hourly) -> Chainlink: Get Latest Round Data -> Code (format price) -> Discord: Send Message`

Read the latest ETH/USD price from Chainlink and post formatted updates to Discord every hour.

### Stale Feed Detection

`Schedule (every 15 min) -> Chainlink: Get Latest Round Data -> Code (check staleness) -> Condition (stale > 1 hour) -> PagerDuty Webhook`

Monitor a Chainlink feed and trigger a PagerDuty alert if the feed has not been updated within the expected heartbeat interval.

### Multi-Feed Price Dashboard

`Schedule (daily) -> Chainlink: Get Latest Answer (ETH/USD) -> Chainlink: Get Latest Answer (BTC/USD) -> Code (format both) -> SendGrid: Email Report`

Aggregate prices from multiple Chainlink feeds into a daily email summary.

### Price Threshold Alert

`Schedule (every 5 min) -> Chainlink: Get Latest Round Data -> Code (format) -> Condition (price < threshold) -> Discord: Alert`

Monitor a price feed and send a Discord alert when the price drops below a configurable threshold.

---

## Supported Chains

| Chain | Price Feeds Available |
|-------|----------------------|
| Ethereum (1) | Yes |
| Base (8453) | Yes |
| Arbitrum (42161) | Yes |
| Optimism (10) | Yes |
| Sepolia (11155111) | Yes (testnet) |

Chainlink price feeds are deployed per trading pair on each chain. Find the correct feed address for your pair and chain at [data.chain.link](https://data.chain.link/). Provide the feed contract address when configuring each action.
