---
title: "Yearn V3"
description: "ERC-4626 yield vaults with automated strategy management on Ethereum, Polygon, and Arbitrum."
---

# Yearn V3

Yearn V3 is a yield aggregator protocol where vaults automatically deploy deposited assets into DeFi strategies to generate yield. All Yearn V3 vaults are fully ERC-4626 compliant. This plugin provides standard vault operations (deposit, withdraw, redeem) and Yearn-specific read actions for monitoring vault performance, strategy allocation, and profit distribution.

Supported chains: Ethereum, Polygon, Arbitrum. Each vault is a separate contract -- you must provide the vault address when configuring actions. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Vault Deposit | Write | Wallet | Deposit assets into a Yearn V3 vault and receive shares |
| Vault Withdraw | Write | Wallet | Withdraw assets from a vault by specifying asset amount |
| Vault Redeem | Write | Wallet | Redeem vault shares for underlying assets |
| Vault Underlying Asset | Read | No | Get the address of the underlying asset token |
| Vault Total Assets | Read | No | Get the total underlying assets held by the vault |
| Vault Total Supply | Read | No | Get the total supply of vault shares |
| Vault Share Balance | Read | No | Get the vault share balance of an address |
| Convert Shares to Assets | Read | No | Convert a share amount to its underlying asset value |
| Convert Assets to Shares | Read | No | Convert an asset amount to the equivalent shares |
| Preview Vault Deposit | Read | No | Preview how many shares a deposit would yield |
| Preview Vault Redeem | Read | No | Preview how many assets a redemption would yield |
| Max Vault Deposit | Read | No | Get the maximum depositable amount for a receiver |
| Max Vault Withdraw | Read | No | Get the maximum withdrawable amount for an owner |
| Price Per Share | Read | No | Get the current price per share in asset terms |
| Total Idle Assets | Read | No | Get assets sitting idle in the vault (not in strategies) |
| Total Debt | Read | No | Get assets deployed to strategies |
| Is Vault Shutdown | Read | No | Check whether the vault has been shut down |
| API Version | Read | No | Get the Yearn vault API version string |
| Profit Max Unlock Time | Read | No | Get the profit unlock duration in seconds |
| Full Profit Unlock Date | Read | No | Get the timestamp when current profits fully unlock |
| Vault Accountant | Read | No | Get the accountant contract address |
| Deposit Limit | Read | No | Get the maximum deposit limit (0 means closed) |

---

## Vault Deposit

Deposit underlying assets into a Yearn V3 vault and receive vault shares in return. The number of shares received depends on the current price per share. Requires prior token approval for the vault contract.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |
| assets | uint256 | Asset Amount (wei) |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Deposit idle assets into yield-generating vaults, automate regular deposits, compound rewards by depositing periodically.

---

## Vault Withdraw

Withdraw a specific amount of underlying assets from a Yearn V3 vault. Burns the corresponding shares from the owner. The vault may need to withdraw from strategies if idle assets are insufficient.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |
| assets | uint256 | Asset Amount (wei) |
| receiver | address | Receiver Address |
| owner | address | Share Owner Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Withdraw funds when needed, automate partial withdrawals based on conditions, emergency exits.

---

## Vault Redeem

Redeem a specific number of vault shares for the underlying assets. The amount of assets received depends on the current price per share.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |
| shares | uint256 | Shares Amount (wei) |
| receiver | address | Receiver Address |
| owner | address | Share Owner Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit a vault position entirely, redeem a specific share amount rather than a target asset amount.

---

## Price Per Share

Get the current price per vault share in underlying asset terms. This value increases over time as the vault earns yield.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| pricePerShare | uint256 | Price Per Share |

**When to use:** Monitor vault performance, calculate APY, compare yield across vaults, track share value over time.

---

## Total Idle Assets

Get the total amount of underlying assets sitting idle in the vault, not currently deployed to any strategy.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalIdle | uint256 | Total Idle Assets |

**When to use:** Monitor vault utilization, check if assets need rebalancing to strategies, assess withdrawal liquidity.

---

## Total Debt

Get the total amount of underlying assets deployed to strategies. This is the vault's "working capital" that generates yield.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalDebt | uint256 | Total Debt |

**When to use:** Monitor strategy allocation, verify vault is actively deploying capital, assess vault health.

---

## Is Vault Shutdown

Check whether a vault has been shut down. A shutdown vault does not accept new deposits but allows withdrawals.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| isShutdown | bool | Shutdown Status |

**When to use:** Monitor vault operational status, trigger emergency withdrawal workflows when a vault shuts down, gate deposit logic.

---

## API Version

Get the Yearn vault API version string (e.g., "3.0.4"). Useful for compatibility checks.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| apiVersion | string | API Version |

**When to use:** Verify vault compatibility, log version information, filter vaults by version.

---

## Profit Max Unlock Time

Get the time in seconds over which profits are linearly unlocked. This smooths profit distribution to prevent sandwich attacks.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| profitMaxUnlockTime | uint256 | Unlock Duration (seconds) |

**When to use:** Monitor profit distribution parameters, optimize deposit/withdrawal timing around profit events.

---

## Full Profit Unlock Date

Get the Unix timestamp when all currently locked profits will be fully unlocked and reflected in the share price.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| fullProfitUnlockDate | uint256 | Unlock Timestamp |

**When to use:** Time withdrawals to capture pending profits, monitor profit unlock schedules, build reporting dashboards.

---

## Vault Accountant

Get the address of the vault's accountant contract that manages fee assessment and profit reporting.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| accountant | address | Accountant Address |

**When to use:** Inspect vault fee configuration, verify accountant contract, governance monitoring.

---

## Deposit Limit

Get the maximum total deposit limit for the vault. A value of 0 means new deposits are not accepted.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Yearn V3 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| depositLimit | uint256 | Deposit Limit |

**When to use:** Check if a vault accepts deposits before attempting one, monitor deposit cap changes, find vaults with available capacity.

---

## Example Workflows

### Monitor Vault Performance

`Schedule (daily) -> Yearn V3: Price Per Share -> Yearn V3: Total Assets -> Math (divide price by decimals) -> HTTP Request (POST to webhook)`

Track vault performance daily by reading the price per share and total assets, then posting results to an external dashboard.

### Auto-Deposit on Capacity

`Schedule (hourly) -> Yearn V3: Deposit Limit -> Condition (> 0) -> Yearn V3: Vault Deposit`

Periodically check if a vault accepts deposits (deposit limit > 0) and automatically deposit when capacity is available.

### Emergency Shutdown Monitor

`Schedule (every 5 min) -> Yearn V3: Is Vault Shutdown -> Condition (== true) -> Yearn V3: Vault Redeem -> Discord: Send Message`

Monitor a vault for shutdown events. If the vault is shut down, automatically redeem all shares and send a Discord alert.

### Vault Utilization Report

`Schedule (daily) -> Yearn V3: Total Idle Assets -> Yearn V3: Total Debt -> Yearn V3: Vault Total Assets -> Math (debt / totalAssets) -> Telegram: Send Message`

Generate a daily utilization report showing idle vs deployed assets and send it via Telegram.

---

## Supported Chains

| Chain | Reference Vault |
|-------|-----------------|
| Ethereum (1) | 0x22028E652a2e937c876F2577f8E78f692d6DAA93 (yvUSDC) |
| Polygon (137) | 0xA013Fbd4b711f9ded6fB09C1c0d358E2FbC2EAA0 |
| Arbitrum (42161) | 0x6FAF8b7fFeE3306EfcFc2BA9Fec912b4d49834C1 |

Since each Yearn V3 vault is a separate contract, you must provide the vault address when configuring any action. The reference addresses above are used only for chain-availability metadata.

---

## Technical Notes

Yearn V3 vaults are deployed as EIP-1167 minimal proxies. The ABI cannot be auto-resolved from block explorers for clones, so this plugin includes a full inline ABI covering the ERC-4626 interface and all Yearn-specific view functions. The inline ABI is used directly by the protocol runtime, bypassing explorer ABI resolution entirely.

Vault decimals match the underlying asset (e.g., 6 for USDC vaults, 18 for DAI vaults). The `pricePerShare` value uses the same decimal precision as the vault shares.
