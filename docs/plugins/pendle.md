---
title: "Pendle Finance Protocol"
description: "Yield tokenization for trading fixed and variable yield on DeFi assets across Ethereum, Base, Arbitrum, and Optimism."
---

# Pendle Finance

Pendle Finance is a yield tokenization protocol that enables trading of fixed and variable yield on DeFi assets. It splits yield-bearing tokens into Principal Tokens (PT) and Yield Tokens (YT), allowing users to trade future yield separately from the underlying asset. This plugin provides actions for reading market data, checking token balances, and minting or redeeming yield-split positions.

Supported chains: Ethereum (all contracts), Base, Arbitrum, and Optimism (Router, Market, PT, YT, SY). The vePENDLE contract is Ethereum-only. Read-only actions work without credentials. Write actions (mint/redeem via Router) require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get vePENDLE Balance | Read | No | Check the vePENDLE voting power balance of an address |
| Get vePENDLE Total Supply | Read | No | Get the stored total vePENDLE supply across all lockers |
| Get vePENDLE Lock Position | Read | No | Get the lock position data for an address (amount and expiry) |
| Get Market Expiry | Read | No | Get the expiry timestamp of a Pendle market |
| Is Market Expired | Read | No | Check whether a Pendle market has passed its expiry date |
| Get LP Balance | Read | No | Check the LP token balance for a Pendle market position |
| Get Active LP Balance | Read | No | Check the active LP balance earning rewards in a market |
| Get PT Balance | Read | No | Check the Principal Token balance of an address |
| Is PT Expired | Read | No | Check whether a Principal Token has passed its maturity date |
| Get YT Balance | Read | No | Check the Yield Token balance of an address |
| Get SY Balance | Read | No | Check the Standardized Yield token balance of an address |
| Get SY Exchange Rate | Read | No | Get the exchange rate between SY and its underlying asset |
| Mint PT and YT from SY | Write | Wallet | Split SY tokens into Principal Tokens and Yield Tokens |
| Redeem PT and YT to SY | Write | Wallet | Merge PT and YT back into Standardized Yield tokens |

---

## Get vePENDLE Balance

Check the vePENDLE voting power balance of any address. vePENDLE represents locked PENDLE tokens used for governance voting and fee sharing.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| user | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint128 | vePENDLE Balance, 18 decimals |

**When to use:** Monitor governance voting power, track vePENDLE holdings across wallets, trigger alerts when voting power drops below a threshold.

---

## Get vePENDLE Total Supply

Get the stored total vePENDLE supply across all lockers. Useful for calculating a wallet's share of total voting power.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint128 | Total vePENDLE Supply, 18 decimals |

**When to use:** Calculate governance power as a percentage of total supply, monitor protocol-wide locking trends, track total locked value over time.

---

## Get vePENDLE Lock Position

Get the lock position data for an address, including the locked PENDLE amount and the lock expiry timestamp.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| user | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| amount | uint128 | Locked PENDLE Amount |
| expiry | uint128 | Lock Expiry Timestamp |

**When to use:** Monitor lock positions, track when locks expire and need renewal, alert before vePENDLE positions expire and lose voting power.

---

## Get Market Expiry

Get the expiry timestamp of a Pendle market. Returns a Unix timestamp indicating when the market matures.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| expiry | uint256 | Expiry Timestamp |

**When to use:** Monitor approaching market expirations, schedule actions around maturity dates, display time-to-expiry in dashboards.

---

## Is Market Expired

Check whether a Pendle market has passed its expiry date. Returns a boolean indicating if the market is expired.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| expired | bool | Is Expired |

**When to use:** Gate actions on market expiry status, filter expired markets from active monitoring, trigger post-expiry redemption workflows.

---

## Get LP Balance

Check the LP token balance for a Pendle market position. LP tokens represent liquidity provided to the PT/SY AMM.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | LP Token Balance, 18 decimals |

**When to use:** Monitor liquidity positions, track LP holdings across wallets, trigger rebalancing when LP balance changes.

---

## Get Active LP Balance

Check the active (non-expired) LP balance earning rewards in a Pendle market. Only active LP earns swap fees and incentive rewards.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| user | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Active LP Balance, 18 decimals |

**When to use:** Monitor reward-earning positions, compare active vs total LP to detect expired positions, trigger alerts when active LP drops.

---

## Get PT Balance

Check the Principal Token balance of an address. PT represents the principal portion of a yield-bearing asset, redeemable at maturity.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | PT Balance, 18 decimals |

**When to use:** Monitor fixed-yield positions, track PT holdings before maturity, trigger redemption workflows when PT expires.

---

## Is PT Expired

Check whether a Principal Token has passed its maturity date. Expired PT can be redeemed for the underlying asset.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| expired | bool | Is Expired |

**When to use:** Trigger automatic redemption of matured PT, filter expired positions from portfolio views, alert when PT approaches maturity.

---

## Get YT Balance

Check the Yield Token balance of an address. YT represents the variable yield portion of a yield-bearing asset.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | YT Balance, 18 decimals |

**When to use:** Monitor variable-yield positions, track YT holdings, calculate total yield exposure across wallets.

---

## Get SY Balance

Check the Standardized Yield token balance of an address. SY wraps yield-bearing tokens into a standard interface used by Pendle.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | SY Balance, 18 decimals |

**When to use:** Check SY holdings before minting PT/YT, monitor wrapped token positions, verify SY balances after deposits.

---

## Get SY Exchange Rate

Get the current exchange rate between SY and its underlying asset. This rate determines how much underlying asset one SY token is worth.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| exchangeRate | uint256 | Exchange Rate, 18 decimals |

**When to use:** Calculate the underlying value of SY positions, monitor yield accrual over time, compare exchange rates across different SY tokens.

---

## Mint PT and YT from SY

Split Standardized Yield tokens into Principal Tokens and Yield Tokens via the PendleRouter. This separates the principal and yield components of a yield-bearing asset. Requires wallet connection.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| receiver | address | Receiver Address |
| YT | address | YT Token Address |
| netSyIn | uint256 | SY Amount (wei) |
| minPyOut | uint256 | Minimum PT/YT Out (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Create fixed-yield positions by selling YT and holding PT, create variable-yield positions by selling PT and holding YT, split positions for yield trading strategies.

---

## Redeem PT and YT to SY

Merge Principal Tokens and Yield Tokens back into Standardized Yield tokens via the PendleRouter. Requires equal amounts of PT and YT. Requires wallet connection.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| receiver | address | Receiver Address |
| YT | address | YT Token Address |
| netPyIn | uint256 | PT/YT Amount (wei) |
| minSyOut | uint256 | Minimum SY Out (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit yield-split positions, recombine PT and YT after maturity, consolidate tokens back into the underlying yield-bearing asset.

---

## Example Workflows

### Monitor vePENDLE Voting Power

`Schedule (daily) -> Pendle: Get vePENDLE Balance -> Math (Sum, divide by 1e18) -> Condition (< 1000) -> Discord: Send Message`

Check your vePENDLE balance daily, convert from wei to decimal, and send a Discord alert if voting power drops below 1000 vePENDLE.

### Track Market Expiry and Alert

`Schedule (hourly) -> Pendle: Is Market Expired -> Condition (equals true) -> SendGrid: Send Email`

Monitor a Pendle market and send an email notification when the market expires, so you can redeem your positions promptly.

### Monitor LP Position Health

`Schedule (daily) -> Pendle: Get LP Balance -> Pendle: Get Active LP Balance -> Math (Sum, divide by 1e18) -> Condition (active < total) -> Discord: Send Message`

Compare total LP balance against active LP balance. If active LP is less than total, some liquidity has expired and is no longer earning rewards -- send an alert to investigate.

### Auto-Alert on SY Exchange Rate Changes

`Schedule (every 6 hours) -> Pendle: Get SY Exchange Rate -> Math (Sum, divide by 1e18) -> Condition (> threshold) -> Webhook: Send Webhook`

Track the SY exchange rate over time and push updates to an external dashboard via webhook when the rate exceeds a target threshold.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | PendleRouter, vePENDLE, Market, PT, YT, SY |
| Base (8453) | PendleRouter, Market, PT, YT, SY |
| Arbitrum One (42161) | PendleRouter, Market, PT, YT, SY |
| Optimism (10) | PendleRouter, Market, PT, YT, SY |

The vePENDLE contract is Ethereum-only. All other contracts are available on all four chains. Market, PT, YT, and SY contracts use user-specified addresses since each market has unique token contracts.
