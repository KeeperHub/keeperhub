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
| Collect Fees | Write | Wallet | Withdraw a position's earned fees to a recipient |
| Decrease Liquidity | Write | Wallet | Remove liquidity from a position, crediting the tokens to it |
| Increase Liquidity | Write | Wallet | Add liquidity to a position you already hold |

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

## Collect Fees

Withdraw the fees a position has earned, plus any tokens a Decrease Liquidity step has credited to it, and send them to a recipient.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenId | uint256 | Position Token ID |
| recipient | address | Address that receives the collected tokens |
| amount0Max | uint128 | Most of token 0 to collect (defaults to the maximum, meaning everything) |
| amount1Max | uint128 | Most of token 1 to collect (defaults to the maximum, meaning everything) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Harvest trading fees on a schedule, or withdraw the tokens a Decrease Liquidity step credited to the position.

The recipient cannot be the zero address or the position manager itself. Uniswap treats both as "leave the tokens in the position manager", where anyone can sweep them, so the step refuses those values rather than sending the fees somewhere unrecoverable.

Get Position Details reports `tokensOwed0` and `tokensOwed1` as of the last time the position was touched, so they do not include fees earned since. They cannot tell a workflow whether there is anything to collect.

---

## Decrease Liquidity

Remove liquidity from a position. The tokens are credited to the position rather than sent to a wallet; a Collect Fees step withdraws them.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenId | uint256 | Position Token ID |
| liquidity | uint128 | Amount of liquidity to remove |
| amount0Min | uint256 | Minimum token 0 to receive, for slippage protection |
| amount1Min | uint256 | Minimum token 1 to receive, for slippage protection |
| deadline | uint256 | Deadline (unix timestamp) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit a position in stages, free capital when a position moves out of range, or empty a position before burning it.

Pair it with Collect Fees. On its own this step moves nothing to your wallet.

---

## Increase Liquidity

Add liquidity to a position that already exists.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| tokenId | uint256 | Position Token ID |
| amount0Desired | uint256 | Most of token 0 to add |
| amount1Desired | uint256 | Most of token 1 to add |
| amount0Min | uint256 | Minimum token 0 to add, for slippage protection |
| amount1Min | uint256 | Minimum token 1 to add, for slippage protection |
| deadline | uint256 | Deadline (unix timestamp) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Compound collected fees back into a position, or top one up on a schedule.

The position manager needs an allowance for both tokens before this step runs - use Approve Token. Supply WETH rather than native ETH.

**Ownership check:** Uniswap performs no ownership check on this call. A wrong token ID deposits your tokens into someone else's position, reports success, and cannot be undone. The step therefore reads the position's owner first and runs only when the holder is one of your organization's wallets: the wallet the step sends from, the owner wallet behind it, or one of your Safes on that chain. Anything else is refused with the holder's address in the message. If the position is yours but held elsewhere, transfer the NFT to one of those wallets. The step also refuses when the owner cannot be read at all, rather than depositing into a position it could not verify.

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
