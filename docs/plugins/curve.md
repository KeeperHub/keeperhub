---
title: "Curve"
description: "Curve Finance stableswap pool operations, token exchanges, expected output quotes, virtual prices, and CRV token management."
---

# Curve

Curve Finance is a decentralized exchange protocol optimized for stablecoin and like-asset swaps using the StableSwap invariant. This plugin provides actions for querying pool state, executing token exchanges, and managing CRV tokens across Ethereum, Base, Arbitrum, and Optimism.

Supported chains: Ethereum (pool + CRV), Base (pool only), Arbitrum (pool + CRV), Optimism (pool + CRV). Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Expected Output | Read | No | Get the expected output amount for a token exchange in a pool |
| Get Virtual Price | Read | No | Get the virtual price of the pool's LP token |
| Get Coin Address | Read | No | Get the token address at a specific index in the pool |
| Get Pool Balance | Read | No | Get the pool's balance of a specific coin by index |
| Exchange Tokens | Write | Wallet | Swap tokens in a Curve pool |
| Get CRV Balance | Read | No | Check CRV token balance of an address |
| Approve CRV | Write | Wallet | Approve an address to spend CRV tokens |
| Transfer CRV | Write | Wallet | Transfer CRV tokens to an address |

---

## Get Expected Output

Get the expected output amount for swapping one token for another in a Curve pool. Uses the StableSwap invariant to calculate the dy (output amount) for a given dx (input amount) and coin indices.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| i | int128 | Input Coin Index |
| j | int128 | Output Coin Index |
| dx | uint256 | Input Amount (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| dy | uint256 | Expected Output (wei) |

**When to use:** Calculate the expected output before executing an exchange, implement slippage checks, compare rates across pools, or build quote workflows to surface best prices.

---

## Get Virtual Price

Get the virtual price of the pool's LP token. The virtual price increases over time as the pool accrues trading fees, representing the cumulative value accrued per LP token.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| virtualPrice | uint256 | Virtual Price (18 decimals) |

**When to use:** Monitor LP token appreciation, track fee accrual over time, verify pool health, or alert when virtual price deviates from expected growth.

---

## Get Coin Address

Get the ERC-20 token address at a specific index position within the pool's coin array.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| arg0 | uint256 | Coin Index |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| coin | address | Token Address |

**When to use:** Discover which tokens are in a pool before interacting with it, validate coin indices, or enumerate all tokens in a user-specified pool.

---

## Get Pool Balance

Get the pool's internal balance of a specific coin by its index. Reflects the total amount of that token held by the pool contract.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| arg0 | uint256 | Coin Index |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Coin Balance (wei) |

**When to use:** Monitor pool liquidity depth, detect pool imbalances, alert when balances fall below thresholds, or track liquidity changes over time.

---

## Exchange Tokens

Swap an exact input amount of one token for at least a minimum output amount of another token in a Curve pool. The caller must have approved the pool to spend the input token.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| i | int128 | Input Coin Index |
| j | int128 | Output Coin Index |
| dx | uint256 | Input Amount (wei) |
| min_dy | uint256 | Minimum Output (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Execute automated stablecoin swaps, rebalance portfolio positions between stablecoins, or perform keeper-triggered swaps when price conditions are met.

---

## Get CRV Balance

Check the CRV governance token balance of any address on Ethereum, Arbitrum, or Optimism.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | CRV Balance (18 decimals) |

**When to use:** Monitor CRV holdings, check balances before approvals or transfers, or trigger workflows based on CRV accumulation thresholds.

---

## Approve CRV

Approve a spender address to spend a specified amount of CRV tokens on behalf of the connected wallet. Required before depositing CRV into gauge contracts or other DeFi protocols.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| spender | address | Spender Address |
| amount | uint256 | Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Grant allowance to a gauge, locker, or other contract before a CRV deposit step, or set up automated approval workflows for CRV operations.

---

## Transfer CRV

Transfer CRV tokens from the connected wallet to a recipient address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| to | address | Recipient Address |
| amount | uint256 | Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Distribute CRV rewards to recipients, consolidate CRV balances to a treasury address, or automate CRV transfers when balance thresholds are reached.

---

## Example Workflows

### Pool Imbalance Monitor

`Schedule (hourly) -> Curve: Get Pool Balance (coin 0) -> Curve: Get Pool Balance (coin 1) -> Condition (ratio out of range) -> Discord: Send Message`

Check the balances of two coins in a stableswap pool every hour. If the ratio deviates beyond an acceptable range (indicating pool imbalance), send a Discord alert.

### Pre-Swap Quote and Execute

`Manual -> Curve: Get Expected Output -> Condition (dy >= min acceptable) -> Curve: Exchange Tokens`

First fetch the expected output for a swap, then only proceed with the exchange if the quote meets a minimum acceptable output. Prevents executing swaps during adverse pool conditions.

### CRV Accumulation Alert

`Schedule (daily) -> Curve: Get CRV Balance -> Condition (balance > threshold) -> Telegram: Send Message`

Monitor a wallet's CRV balance daily. When it accumulates above a set threshold, send a Telegram notification signaling it may be time to lock or deploy the CRV.

### Virtual Price Deviation Alert

`Schedule (hourly) -> Curve: Get Virtual Price -> Condition (price < expected floor) -> Discord: Send Message`

Track the virtual price of a Curve LP token. If it drops below the expected floor (which should only increase over time), alert via Discord as this may indicate a pool exploit or manipulation.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | Curve Pool, CRV Token |
| Base (8453) | Curve Pool |
| Arbitrum (42161) | Curve Pool, CRV Token |
| Optimism (10) | Curve Pool, CRV Token |

The CRV token is not deployed on Base. Pool actions using a user-specified pool address are available on all four chains.
