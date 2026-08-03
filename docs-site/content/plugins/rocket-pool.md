---
title: "Rocket Pool"
description: "Decentralized Ethereum liquid staking -- deposit ETH for rETH, monitor exchange rates, balances, and total supply on Ethereum Mainnet."
---

# Rocket Pool

Rocket Pool is a decentralized Ethereum liquid staking protocol. Users deposit ETH and receive rETH, a liquid staking token that accrues staking rewards over time. The rETH/ETH exchange rate increases as validators earn rewards, meaning rETH holders earn yield without locking their tokens.

Supported chains: Ethereum Mainnet only. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get rETH Exchange Rate | Read | No | Get the current ETH value of 1 rETH |
| Get rETH Balance | Read | No | Check rETH balance of an address |
| Get rETH Total Supply | Read | No | Get total rETH tokens in circulation |
| Get Total ETH Collateral | Read | No | Get total ETH collateral held by rETH contract |
| Deposit ETH for rETH | Write | Wallet | Deposit ETH to receive rETH |
| Burn rETH for ETH | Write | Wallet | Burn rETH to receive underlying ETH |

---

## Get rETH Exchange Rate

Get the current ETH value of 1 rETH. The exchange rate increases over time as staking rewards accrue. This is the core metric for tracking Rocket Pool yield.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| rate | uint256 | Exchange Rate (wei per rETH), 18 decimals |

**When to use:** Monitor staking yield over time, calculate the ETH value of rETH holdings, trigger actions based on rate changes, compare with other liquid staking protocols.

---

## Get rETH Balance

Check the rETH balance of any Ethereum address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | rETH Balance (wei), 18 decimals |

**When to use:** Monitor rETH holdings, track staking positions across wallets, trigger alerts when balances change.

---

## Get rETH Total Supply

Get the total supply of rETH tokens currently in circulation. This reflects the total amount of ETH staked through Rocket Pool.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint256 | Total rETH Supply (wei), 18 decimals |

**When to use:** Monitor protocol growth, track total staked ETH through Rocket Pool, analyze protocol adoption trends.

---

## Get Total ETH Collateral

Get the total amount of ETH collateral backing the rETH token. This represents the total ETH held by the protocol including staking rewards.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalCollateral | uint256 | Total ETH Collateral (wei), 18 decimals |

**When to use:** Monitor protocol TVL, verify collateralization ratio, track total staking rewards earned by the protocol.

---

## Deposit ETH for rETH

Deposit ETH into Rocket Pool to receive rETH liquid staking tokens. The amount of rETH received depends on the current exchange rate. Send ETH value with the transaction.

**Inputs:** None (ETH is sent as transaction value)

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Stake ETH for liquid staking yield, automate deposits when ETH balance exceeds a threshold, dollar-cost-average into rETH positions.

---

## Burn rETH for ETH

Burn rETH tokens to receive the underlying ETH back at the current exchange rate. The amount of ETH received will be greater than the original deposit if staking rewards have accrued.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| amount | uint256 | rETH Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit staking position, realize accrued staking rewards, rebalance portfolio away from liquid staking.

---

## Example Workflows

### rETH Exchange Rate Monitor

`Schedule (hourly) -> Rocket Pool: Get rETH Exchange Rate -> Code (rate / 1e18) -> Discord: Send Message`

Track the rETH exchange rate over time and send hourly updates to a Discord channel. Useful for monitoring staking yield accrual.

### rETH Balance Tracker with Alert

`Schedule (daily) -> Rocket Pool: Get rETH Balance -> Code (balance / 1e18) -> Condition (< threshold) -> Discord: Send Message`

Monitor your rETH holdings and receive a Discord alert if the balance drops below a specified threshold.

### Staking Yield Calculator

`Schedule (daily) -> Rocket Pool: Get rETH Exchange Rate -> Rocket Pool: Get rETH Balance -> Code (balance * rate / 1e18 / 1e18) -> SendGrid: Send Email`

Calculate the current ETH value of your rETH position and email a daily summary. Combines exchange rate with balance to show total staked value.

### Protocol TVL Monitor

`Schedule (daily) -> Rocket Pool: Get Total ETH Collateral -> Code (collateral / 1e18) -> Webhook: Send HTTP Request`

Track the total ETH collateral in Rocket Pool and send daily TVL data to an external service for dashboards or analytics.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | rETH Token, Rocket Deposit Pool |

Rocket Pool contracts are available on Ethereum Mainnet only. The rETH token is the liquid staking token (ERC-20) with exchange rate functions. The Rocket Deposit Pool handles ETH deposits for new stakers.
