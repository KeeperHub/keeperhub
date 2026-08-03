---
title: "Lido"
description: "Liquid staking for Ethereum -- wrap stETH to wstETH, unwrap back, query exchange rates, and monitor balances across Ethereum, Base, and Sepolia."
---

# Lido

Lido is the largest liquid staking protocol on Ethereum. Users stake ETH and receive stETH, a rebasing token that accrues staking rewards. wstETH is a non-rebasing wrapper around stETH, suitable for DeFi protocols and cross-chain bridging. The wstETH/stETH exchange rate increases over time as staking rewards accrue.

Supported chains: Ethereum Mainnet (wrap/unwrap + all reads), Base (balance only), Sepolia Testnet. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Wrap stETH to wstETH | Write | Wallet | Wrap stETH tokens into non-rebasing wstETH |
| Unwrap wstETH to stETH | Write | Wallet | Unwrap wstETH back to rebasing stETH |
| Approve stETH Spending | Write | Wallet | Approve a spender to transfer stETH |
| Get stETH by wstETH | Read | No | Convert a wstETH amount to stETH value |
| Get wstETH by stETH | Read | No | Convert a stETH amount to wstETH value |
| stETH Per Token (Exchange Rate) | Read | No | Get the stETH value of 1 wstETH |
| wstETH Per stETH (Inverse Rate) | Read | No | Get the wstETH value of 1 stETH |
| Get wstETH Balance | Read | No | Check wstETH balance of an address |
| Get wstETH Total Supply | Read | No | Get total wstETH tokens in circulation |
| Get stETH Balance | Read | No | Check stETH balance of an address |

---

## Wrap stETH to wstETH

Wrap stETH tokens into non-rebasing wstETH. Requires stETH approval to the wstETH contract first (use the Approve stETH Spending action). The amount of wstETH received depends on the current exchange rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _stETHAmount | uint256 | stETH Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Convert stETH to wstETH for use in DeFi protocols that do not support rebasing tokens, prepare for cross-chain bridging, or hold a non-rebasing staking position.

---

## Unwrap wstETH to stETH

Unwrap wstETH back to rebasing stETH at the current exchange rate. The amount of stETH received will be greater than the original wrap if staking rewards have accrued since wrapping.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _wstETHAmount | uint256 | wstETH Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Convert wstETH back to stETH to receive rebasing rewards directly, or exit a wstETH position.

---

## Approve stETH Spending

Approve the wstETH contract (or another spender) to transfer stETH on your behalf. This must be done before wrapping stETH to wstETH.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| spender | address | Spender Address |
| amount | uint256 | Approval Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Grant stETH spending approval before wrapping, or approve other DeFi protocols to use your stETH.

---

## Get stETH by wstETH

Convert a wstETH amount to its equivalent stETH value at the current exchange rate. Useful for calculating the underlying stETH value of a wstETH position.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _wstETHAmount | uint256 | wstETH Amount (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| stETHAmount | uint256 | stETH Value (wei), 18 decimals |

**When to use:** Calculate the stETH value of wstETH holdings, display human-readable staking position values, build portfolio dashboards.

---

## Get wstETH by stETH

Convert a stETH amount to its equivalent wstETH value at the current exchange rate. Useful for previewing how much wstETH a given stETH amount would produce when wrapped.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| _stETHAmount | uint256 | stETH Amount (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| wstETHAmount | uint256 | wstETH Value (wei), 18 decimals |

**When to use:** Preview wrap amounts before executing, calculate wstETH equivalents for stETH positions, compare rates across protocols.

---

## stETH Per Token (Exchange Rate)

Get the current stETH value of 1 wstETH. This is the primary exchange rate that increases over time as staking rewards accrue. The rate starts above 1.0 and grows monotonically.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| rate | uint256 | stETH per wstETH (wei), 18 decimals |

**When to use:** Monitor staking yield accrual, track the wstETH exchange rate over time, trigger actions based on rate changes, compare with other liquid staking protocols.

---

## wstETH Per stETH (Inverse Rate)

Get the current wstETH value of 1 stETH. This is the inverse of the exchange rate and decreases over time as staking rewards accrue.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| rate | uint256 | wstETH per stETH (wei), 18 decimals |

**When to use:** Calculate how much wstETH 1 stETH can produce, compare inverse rates, build rate conversion utilities.

---

## Get wstETH Balance

Check the wstETH balance of any Ethereum address. Works on Ethereum Mainnet, Base, and Sepolia.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | wstETH Balance (wei), 18 decimals |

**When to use:** Monitor wstETH holdings, track staking positions across wallets, trigger alerts when balances change.

---

## Get wstETH Total Supply

Get the total supply of wstETH tokens currently in circulation.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint256 | Total wstETH Supply (wei), 18 decimals |

**When to use:** Monitor protocol adoption, track total wrapped stETH, analyze wrapping trends.

---

## Get stETH Balance

Check the stETH balance of any Ethereum address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | stETH Balance (wei), 18 decimals |

**When to use:** Monitor stETH holdings, check available balance before wrapping, track rebasing rewards.

---

## Example Workflows

### wstETH Exchange Rate Monitor

`Schedule (hourly) -> Lido: stETH Per Token -> Code (rate / 1e18) -> Discord: Send Message`

Track the wstETH exchange rate over time and send hourly updates to a Discord channel. Useful for monitoring staking yield accrual.

### wstETH Position Value Tracker

`Schedule (daily) -> Lido: Get wstETH Balance -> Lido: stETH Per Token -> Code (balance * rate / 1e36) -> SendGrid: Send Email`

Calculate the current stETH value of your wstETH position and email a daily summary. Combines exchange rate with balance to show total staked value.

### stETH/wstETH Rate Alert

`Schedule (hourly) -> Lido: stETH Per Token -> Code (rate / 1e18) -> Condition (> threshold) -> Discord: Send Message`

Monitor the wstETH exchange rate and alert when it crosses a threshold, useful for tracking significant yield milestones.

### wstETH Total Supply Dashboard

`Schedule (daily) -> Lido: Get wstETH Total Supply -> Lido: stETH Per Token -> Code (supply * rate / 1e36) -> Webhook: Send HTTP Request`

Track total wstETH supply and its stETH value, sending daily data to an external dashboard or analytics service.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | wstETH, stETH |
| Base (8453) | wstETH (bridged, balance only) |
| Sepolia (11155111) | wstETH, stETH (testnet) |

On Ethereum Mainnet, all wrap/unwrap and conversion functions are available. On Base, wstETH is a bridged ERC-20 token with balance queries only. Sepolia provides testnet versions for development.
