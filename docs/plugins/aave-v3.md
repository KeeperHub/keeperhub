---
title: "Aave V3"
description: "Lending and borrowing protocol -- supply assets, borrow against collateral, repay debt, and monitor account health on Ethereum, Base, Arbitrum, and Optimism."
---

# Aave V3

Aave V3 is a decentralized non-custodial lending and borrowing protocol. Users can supply assets to earn interest, borrow assets against their collateral, and manage their positions across multiple chains. This plugin provides actions for core lending operations and account health monitoring.

Supported chains: Ethereum, Base, Arbitrum, Optimism (all contracts available on all chains). Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Supply Asset | Write | Wallet | Supply an asset to earn interest |
| Withdraw Asset | Write | Wallet | Withdraw a supplied asset |
| Borrow Asset | Write | Wallet | Borrow against supplied collateral |
| Repay Debt | Write | Wallet | Repay a borrowed asset |
| Set Asset as Collateral | Write | Wallet | Enable or disable an asset as collateral |
| Get User Account Data | Read | No | Get overall account health and balances |
| Get User Reserve Data | Read | No | Get per-asset position data and rates |

---

## Supply Asset

Supply an asset to the Aave V3 lending pool to earn interest. The supplied asset automatically starts accruing interest. Requires prior ERC-20 approval for the Pool contract.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| amount | uint256 | Amount (wei) |
| onBehalfOf | address | On Behalf Of Address |
| referralCode | uint16 | Referral Code (default: 0) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Earn yield on idle tokens, automate deposits when conditions are met, build supply strategies based on rate changes.

---

## Withdraw Asset

Withdraw a supplied asset from the Aave V3 lending pool. Ensure the withdrawal does not bring the health factor below 1 if the asset is used as collateral.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| amount | uint256 | Amount (wei) |
| to | address | Recipient Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Withdraw funds when needed, automate withdrawals based on rate drops, rebalance collateral positions.

---

## Borrow Asset

Borrow an asset from the Aave V3 lending pool against supplied collateral. Variable rate (mode 2) is the standard borrowing mode.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| amount | uint256 | Amount (wei) |
| interestRateMode | uint256 | Interest Rate Mode (2=Variable, default: 2) |
| referralCode | uint16 | Referral Code (default: 0) |
| onBehalfOf | address | On Behalf Of Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Borrow stablecoins against volatile assets, leverage positions, automate borrowing based on market conditions.

---

## Repay Debt

Repay a borrowed asset to the Aave V3 lending pool. Use `type(uint256).max` as amount to repay the entire debt.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| amount | uint256 | Amount (wei) |
| interestRateMode | uint256 | Interest Rate Mode (2=Variable, default: 2) |
| onBehalfOf | address | On Behalf Of Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Automate debt repayment when health factor drops, repay before liquidation, scheduled debt reduction.

---

## Set Asset as Collateral

Enable or disable a supplied asset as collateral in Aave V3. Disabling collateral increases available borrows for other assets but may reduce overall borrow capacity.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| useAsCollateral | bool | Use as Collateral |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Manage collateral exposure, disable volatile assets as collateral during market uncertainty, optimize borrow capacity.

---

## Get User Account Data

Get overall account health including total collateral, total debt, available borrow power, and health factor. Base currency values are denominated in USD with 8 decimal precision.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| user | address | User Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalCollateralBase | uint256 | Total Collateral (base currency), 8 decimals |
| totalDebtBase | uint256 | Total Debt (base currency), 8 decimals |
| availableBorrowsBase | uint256 | Available Borrows (base currency), 8 decimals |
| currentLiquidationThreshold | uint256 | Liquidation Threshold (basis points) |
| ltv | uint256 | Loan-to-Value (basis points) |
| healthFactor | uint256 | Health Factor, 18 decimals (1e18 = 1.0) |

**When to use:** Monitor account health factor for liquidation protection, check borrow capacity before opening new positions, track portfolio-level collateral and debt.

---

## Get User Reserve Data

Get per-asset position data including supplied balance, outstanding debt, borrow rates, and collateral status. Returns data from the Aave V3 Pool Data Provider.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| user | address | User Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| currentATokenBalance | uint256 | Supplied Balance (aToken) |
| currentStableDebtTokenBalance | uint256 | Stable Debt Balance |
| currentVariableDebtTokenBalance | uint256 | Variable Debt Balance |
| principalStableDebt | uint256 | Principal Stable Debt |
| scaledVariableDebt | uint256 | Scaled Variable Debt |
| stableBorrowRate | uint256 | Stable Borrow Rate (ray), 27 decimals |
| liquidityRate | uint256 | Supply APY (ray), 27 decimals |
| stableRateLastUpdated | uint40 | Stable Rate Last Updated (timestamp) |
| usageAsCollateralEnabled | bool | Used as Collateral |

**When to use:** Monitor individual asset positions, track supply APY changes, check if an asset is enabled as collateral, compare debt across assets.

---

## Example Workflows

### Health Factor Monitor with Alert

`Schedule (every 5 min) -> Aave V3: Get User Account Data -> Code (healthFactor / 1e18) -> Condition (< 1.5) -> Discord: Send Message`

Monitor your Aave V3 health factor and send a Discord alert when it drops below 1.5, giving you time to act before liquidation.

### Auto-Repay on Low Health Factor

`Schedule (every 5 min) -> Aave V3: Get User Account Data -> Code (healthFactor / 1e18) -> Condition (< 1.2) -> Aave V3: Repay Debt`

Automatically repay debt when health factor approaches the liquidation threshold. Requires wallet connection and token approval.

### Track Supply APY

`Schedule (hourly) -> Aave V3: Get User Reserve Data -> Code (liquidityRate / 1e27 * 100) -> Webhook: Send HTTP Request`

Monitor the supply APY for a specific asset and send the rate to an external service for tracking or alerting.

### Collateral Rebalancing

`Schedule (daily) -> Aave V3: Get User Account Data -> Code (check LTV vs threshold) -> Condition (LTV > 70% of threshold) -> Aave V3: Withdraw Asset -> Aave V3: Repay Debt`

Periodically check if your LTV is approaching the liquidation threshold and automatically deleverage by withdrawing collateral to repay debt.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | Pool, Pool Data Provider |
| Base (8453) | Pool, Pool Data Provider |
| Arbitrum (42161) | Pool, Pool Data Provider |
| Optimism (10) | Pool, Pool Data Provider |

All contracts are available on all four supported chains. The Pool is the main user-facing contract for supply, withdraw, borrow, and repay operations. The Pool Data Provider exposes read-only functions for detailed position and rate data.
