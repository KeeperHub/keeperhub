---
title: "MetaMorpho"
description: "ERC-4626 curated lending vaults built on Morpho Blue -- deposit, withdraw, redeem, and monitor vault state across Ethereum and Base."
---

# MetaMorpho

MetaMorpho vaults are ERC-4626 compliant tokenized lending vaults built on top of Morpho Blue. Each vault is managed by a risk curator (such as Steakhouse, Gauntlet, or Re7) who allocates deposits across multiple Morpho Blue markets to optimize yield while managing risk. Depositors receive vault shares representing their proportional claim on the underlying assets.

Because MetaMorpho vaults are fully ERC-4626 compliant, this plugin provides the standard vault interface: deposit, withdraw, redeem, and a full set of read-only queries for vault state, share conversions, and deposit/withdraw limits.

MetaMorpho vaults are deployed on Ethereum (1) and Base (8453). Since many vaults exist from different curators, the vault address is user-specified rather than hardcoded. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Vault Deposit | Write | Wallet | Deposit assets into a MetaMorpho vault and receive shares |
| Vault Withdraw | Write | Wallet | Withdraw assets from a vault by specifying asset amount |
| Vault Redeem | Write | Wallet | Redeem vault shares for underlying assets |
| Vault Underlying Asset | Read | No | Get the address of the underlying asset token |
| Vault Total Assets | Read | No | Get the total amount of underlying assets held by the vault |
| Vault Total Supply | Read | No | Get the total supply of vault shares |
| Vault Share Balance | Read | No | Get the vault share balance of an address |
| Convert Shares to Assets | Read | No | Convert a share amount to its underlying asset value |
| Convert Assets to Shares | Read | No | Convert an asset amount to equivalent vault shares |
| Preview Vault Deposit | Read | No | Preview how many shares a deposit would yield |
| Preview Vault Redeem | Read | No | Preview how many assets a redemption would yield |
| Max Vault Deposit | Read | No | Get the maximum deposit amount for a receiver |
| Max Vault Withdraw | Read | No | Get the maximum withdrawal amount for an owner |

---

## Vault Deposit

Deposit underlying assets (e.g., USDC) into a MetaMorpho vault. Shares are minted to the receiver proportional to the current exchange rate. Requires prior approval of the underlying asset for the vault contract.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| assets | uint256 | Asset Amount (wei) |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Earn yield on idle stablecoins, automate deposits into curated lending strategies, allocate funds to vaults with the best risk-adjusted returns.

---

## Vault Withdraw

Withdraw a specific amount of underlying assets from a MetaMorpho vault. Burns the corresponding shares from the owner.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| assets | uint256 | Asset Amount (wei) |
| receiver | address | Receiver Address |
| owner | address | Share Owner Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit vault positions, withdraw funds when needed, automate withdrawals based on yield or risk conditions.

---

## Vault Redeem

Redeem a specific number of vault shares for the underlying assets. The amount of assets received depends on the current exchange rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| shares | uint256 | Shares Amount (wei) |
| receiver | address | Receiver Address |
| owner | address | Share Owner Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit a position entirely, redeem a specific share amount rather than a target asset amount.

---

## Vault Underlying Asset

Get the address of the underlying asset token for a MetaMorpho vault (e.g., USDC for the Steakhouse USDC vault).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| asset | address | Underlying Asset Address |

**When to use:** Discover what token a vault accepts, verify vault configuration before depositing.

---

## Vault Total Assets

Get the total amount of underlying assets held by the vault across all Morpho Blue markets.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalAssets | uint256 | Total Assets (wei), 18 decimals |

**When to use:** Monitor vault TVL, track growth over time, compare vault sizes across curators.

---

## Vault Total Supply

Get the total supply of vault shares outstanding.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint256 | Total Shares (wei), 18 decimals |

**When to use:** Calculate share price (totalAssets / totalSupply), monitor vault utilization.

---

## Vault Share Balance

Get the vault share balance of any address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Share Balance (wei), 18 decimals |

**When to use:** Monitor your vault position, track share holdings across wallets, trigger actions based on balance thresholds.

---

## Convert Shares to Assets

Convert a vault share amount to its underlying asset value at the current exchange rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| shares | uint256 | Shares Amount (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| assets | uint256 | Asset Value (wei), 18 decimals |

**When to use:** Calculate the current value of a vault position, monitor accrued yield, display portfolio values in asset terms.

---

## Convert Assets to Shares

Convert an asset amount to the equivalent vault shares at the current rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| assets | uint256 | Asset Amount (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| shares | uint256 | Shares Amount (wei), 18 decimals |

**When to use:** Calculate how many shares a deposit would give you, estimate position sizes.

---

## Preview Vault Deposit

Preview how many vault shares a given asset deposit would yield at the current exchange rate. Does not execute a transaction.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| assets | uint256 | Asset Amount (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| shares | uint256 | Shares Received (wei), 18 decimals |

**When to use:** Preview expected shares before depositing, compare deposit rates across vaults.

---

## Preview Vault Redeem

Preview how many underlying assets a given share redemption would yield. Does not execute a transaction.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| shares | uint256 | Shares Amount (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| assets | uint256 | Assets Received (wei), 18 decimals |

**When to use:** Calculate expected assets before redeeming, monitor exchange rate trends.

---

## Max Vault Deposit

Get the maximum amount of underlying assets that can be deposited into the vault for a given receiver.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| receiver | address | Receiver Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| maxAssets | uint256 | Max Deposit (wei), 18 decimals |

**When to use:** Check vault capacity before large deposits, verify the vault is accepting deposits (not paused or at cap).

---

## Max Vault Withdraw

Get the maximum amount of underlying assets that can be withdrawn by a given owner.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | MetaMorpho Vault Address |
| owner | address | Owner Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| maxAssets | uint256 | Max Withdraw (wei), 18 decimals |

**When to use:** Check available liquidity before withdrawing, verify withdrawal limits, detect if a vault has sufficient liquidity.

---

## Example Workflows

### Monitor Vault TVL

`Schedule (daily) -> MetaMorpho: Vault Total Assets -> Math (divide by 1e6 for USDC) -> Condition (< threshold) -> Discord: Send Message`

Track the total value locked in a MetaMorpho vault and send an alert if it drops below a threshold, which could indicate mass withdrawals.

### Track Vault Yield

`Schedule (daily) -> MetaMorpho: Convert Shares to Assets (1e18 shares) -> Math (subtract previous day value) -> Condition (> 0) -> Webhook: Send`

Monitor the exchange rate of a vault to calculate daily yield. Compare today's rate against a stored value to detect yield changes.

### Auto-Deposit into Best Vault

`Schedule (hourly) -> MetaMorpho: Preview Vault Deposit (vault A) -> MetaMorpho: Preview Vault Deposit (vault B) -> Condition (A shares > B shares) -> MetaMorpho: Vault Deposit`

Compare deposit rates across two curated vaults and deposit into the one offering the most shares per asset.

### Vault Capacity Check Before Deposit

`Manual -> MetaMorpho: Max Vault Deposit -> Condition (maxAssets > deposit amount) -> MetaMorpho: Vault Deposit`

Verify a vault can accept your deposit before executing the transaction. Prevents failed transactions when a vault is at capacity or paused.

### Withdrawal Liquidity Monitor

`Schedule (hourly) -> MetaMorpho: Max Vault Withdraw -> Condition (maxAssets < position value) -> Telegram: Send Message`

Monitor available withdrawal liquidity and alert when it drops below your position size, indicating potential liquidity constraints.

---

## Supported Chains

| Chain | Description |
|-------|-------------|
| Ethereum (1) | Primary deployment, most vaults and liquidity |
| Base (8453) | Growing ecosystem of MetaMorpho vaults |

MetaMorpho vaults use user-specified addresses since many vaults exist from different curators. Popular vaults include Steakhouse USDC (0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB on Ethereum) and various Gauntlet and Re7 vaults. Browse available vaults at https://app.morpho.org.
