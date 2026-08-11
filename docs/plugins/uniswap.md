---
title: "Uniswap"
description: "Uniswap V3 pool discovery, liquidity position management, and NFT operations on Ethereum, Base, Arbitrum, and Optimism."
---

# Uniswap

Uniswap V3 is the leading decentralized exchange protocol for automated market making with concentrated liquidity. This plugin provides actions for discovering pool addresses, inspecting liquidity positions, and managing position NFTs across four chains.

Supported chains: Ethereum, Base, Arbitrum, Optimism (all contracts on all chains). Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Pool Address | Read | No | Find the pool address for a token pair and fee tier |
| Get Position Details | Read | No | Get full details of a liquidity position by NFT token ID |
| Get Position Count | Read | No | Check how many LP position NFTs an address owns |
| Get Position Owner | Read | No | Get the owner address of a position NFT |
| Approve Position Transfer | Write | Wallet | Approve an address to manage a position NFT |
| Transfer Position NFT | Write | Wallet | Transfer a position NFT to another address |
| Burn Empty Position | Write | Wallet | Burn an empty position NFT |

---

## Get Pool Address

Find the Uniswap V3 pool address for a specific token pair and fee tier. Returns the zero address if no pool exists for the given parameters.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenA | address | Token A Address |
| tokenB | address | Token B Address |
| fee | uint24 | Fee Tier (100, 500, 3000, or 10000) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| pool | address | Pool Address |

**When to use:** Discover pool addresses before reading pool state, validate that a pool exists for a token pair, build multi-step workflows that route through specific pools.

---

## Get Position Details

Get full details of a liquidity position by its NFT token ID. Returns token pair, fee tier, tick range, liquidity amount, and accrued fees.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenId | uint256 | Position Token ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| nonce | uint96 | Nonce |
| operator | address | Operator Address |
| token0 | address | Token 0 Address |
| token1 | address | Token 1 Address |
| fee | uint24 | Fee Tier |
| tickLower | int24 | Lower Tick |
| tickUpper | int24 | Upper Tick |
| liquidity | uint128 | Liquidity |
| feeGrowthInside0LastX128 | uint256 | Fee Growth Inside 0 (X128) |
| feeGrowthInside1LastX128 | uint256 | Fee Growth Inside 1 (X128) |
| tokensOwed0 | uint128 | Tokens Owed 0 |
| tokensOwed1 | uint128 | Tokens Owed 1 |

**When to use:** Monitor liquidity positions, check accrued fees (tokensOwed0/tokensOwed1), verify position tick range and liquidity, build alerts based on position state.

---

## Get Position Count

Check how many Uniswap V3 LP position NFTs an address owns.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| owner | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Position Count |

**When to use:** Monitor total LP positions for a wallet, detect when positions are added or removed, trigger workflows based on position count changes.

---

## Get Position Owner

Get the owner address of a specific liquidity position NFT.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenId | uint256 | Position Token ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| owner | address | Owner Address |

**When to use:** Verify ownership of a position before interacting with it, monitor position transfers, track ownership changes.

---

## Approve Position Transfer

Approve an address to manage a specific liquidity position NFT. The approved address can then transfer, collect fees, or modify the position.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| to | address | Approved Address |
| tokenId | uint256 | Position Token ID |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Grant another contract or address permission to manage a position, set up automated position management.

---

## Transfer Position NFT

Transfer a liquidity position NFT from one address to another. The caller must be the owner or an approved operator.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| from | address | From Address |
| to | address | To Address |
| tokenId | uint256 | Position Token ID |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Move positions between wallets, transfer positions to a multisig for management, consolidate positions.

---

## Burn Empty Position

Burn an empty liquidity position NFT. The position must have zero liquidity and zero owed tokens before it can be burned.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenId | uint256 | Position Token ID |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Clean up closed positions, reduce NFT clutter after removing all liquidity and collecting fees.

---

## Example Workflows

### Monitor LP Position Health

`Schedule (hourly) -> Uniswap: Get Position Details -> Condition (liquidity = 0) -> Discord: Send Message`

Periodically check a position's liquidity. If it drops to zero (fully out of range and drained), send a Discord alert.

### Track Accrued Fees

`Schedule (daily) -> Uniswap: Get Position Details -> Condition (tokensOwed0 > threshold) -> Telegram: Send Message`

Monitor accrued fees on a position and notify via Telegram when they exceed a threshold, signaling it may be time to collect.

### Pool Existence Check

`Manual -> Uniswap: Get Pool Address -> Condition (pool != 0x0000...0000) -> HTTP Request (POST pool data to webhook)`

Verify that a Uniswap V3 pool exists for a token pair before proceeding with further operations.

### Position Ownership Monitor

`Schedule (hourly) -> Uniswap: Get Position Owner -> Condition (owner changed) -> Discord: Send Message`

Monitor a high-value position NFT for ownership changes and alert on unexpected transfers.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | Factory, NonfungiblePositionManager |
| Base (8453) | Factory, NonfungiblePositionManager |
| Arbitrum (42161) | Factory, NonfungiblePositionManager |
| Optimism (10) | Factory, NonfungiblePositionManager |

Both contracts are available on all four supported chains.
