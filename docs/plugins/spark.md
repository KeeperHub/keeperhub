---
title: "Spark"
description: "Lending and borrowing protocol (Aave V3 fork) in the Sky/Maker ecosystem -- supply assets, borrow against collateral, and earn the DAI Savings Rate via sDAI on Ethereum."
---

# Spark

Spark is a decentralized lending protocol built as an Aave V3 fork within the Sky/Maker ecosystem. Users can supply assets to earn interest, borrow against collateral, and deposit DAI into the sDAI savings vault to earn the DAI Savings Rate (DSR). SparkLend uses the same Pool interface as Aave V3 for core lending operations.

Supported chains: Ethereum (all contracts) and Gnosis Chain (lending contracts only, no sDAI). Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Supply Asset | Write | Wallet | Supply an asset to earn interest |
| Withdraw Asset | Write | Wallet | Withdraw a supplied asset |
| Borrow Asset | Write | Wallet | Borrow against supplied collateral |
| Repay Debt | Write | Wallet | Repay a borrowed asset |
| Set Asset as Collateral | Write | Wallet | Enable or disable a supplied asset as collateral |
| Deposit DAI to sDAI | Write | Wallet | Deposit DAI into the sDAI vault (DSR) |
| Redeem sDAI for DAI | Write | Wallet | Redeem sDAI shares for DAI |
| Get User Account Data | Read | No | Get overall account health and balances |
| Get User Reserve Data | Read | No | Get per-asset position data and rates |
| Get sDAI Balance | Read | No | Check sDAI balance of an address |
| Get sDAI Total Assets | Read | No | Get total DAI locked in the sDAI vault |
| Convert sDAI to DAI Value | Read | No | Preview sDAI to DAI conversion at current rate |

---

## Supply Asset

Supply an asset to the SparkLend lending pool to earn interest. The supplied asset automatically starts accruing interest. Requires prior ERC-20 approval for the Pool contract.

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

Withdraw a supplied asset from the SparkLend lending pool. Ensure the withdrawal does not bring the health factor below 1 if the asset is used as collateral.

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

Borrow an asset from SparkLend against supplied collateral. Variable rate (mode 2) is the standard borrowing mode.

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

Repay a borrowed asset to the SparkLend lending pool. Use `type(uint256).max` as amount to repay the entire debt.

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

Enable or disable a supplied asset as collateral in SparkLend. This toggles the entire supplied balance of the asset -- there is no partial collateral in Aave V3/Spark.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| useAsCollateral | bool | Use as Collateral (toggles entire supplied balance) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Enable collateral on a newly supplied asset before borrowing, disable collateral to protect an asset from liquidation, automate collateral management based on market conditions.

---

## Deposit DAI to sDAI

Deposit DAI into the sDAI savings vault (ERC-4626) to earn the DAI Savings Rate. Requires prior DAI approval for the sDAI contract. The DSR yield accrues automatically via the exchange rate between sDAI and DAI.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| assets | uint256 | DAI Amount (wei) |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Park idle DAI in the DSR for risk-free yield, automate DAI savings deposits, build yield farming pipelines.

---

## Redeem sDAI for DAI

Redeem sDAI shares for DAI from the savings vault. The DAI received includes accrued DSR yield based on the current exchange rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| shares | uint256 | sDAI Shares (wei) |
| receiver | address | Receiver Address |
| owner | address | Share Owner Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit the DSR to redeploy capital, automate redemptions based on rate changes, withdraw savings for operational use.

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

Get per-asset position data including supplied balance (spToken), stable and variable debt, borrow rates, and whether the asset is used as collateral. Uses the Pool Data Provider contract.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| user | address | User Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| currentATokenBalance | uint256 | Supplied Balance (spToken) |
| currentStableDebtTokenBalance | uint256 | Stable Debt Balance |
| currentVariableDebtTokenBalance | uint256 | Variable Debt Balance |
| principalStableDebt | uint256 | Principal Stable Debt |
| scaledVariableDebt | uint256 | Scaled Variable Debt |
| stableBorrowRate | uint256 | Stable Borrow Rate (ray), 27 decimals |
| liquidityRate | uint256 | Supply APY (ray), 27 decimals |
| stableRateLastUpdated | uint40 | Stable Rate Last Updated (timestamp) |
| usageAsCollateralEnabled | bool | Whether asset is used as collateral |

**When to use:** Check per-asset balances and debt, monitor supply APY for rate-based strategies, verify collateral status before borrowing.

---

## Get sDAI Balance

Check the sDAI balance of an address. The sDAI balance represents shares in the savings vault. Use "Convert sDAI to DAI Value" to see the underlying DAI value.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | sDAI Balance (wei), 18 decimals |

**When to use:** Check savings position size, monitor sDAI holdings across wallets, trigger actions based on balance thresholds.

---

## Get sDAI Total Assets

Get the total DAI held in the sDAI vault, representing the total value locked earning the DSR.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalAssets | uint256 | Total DAI in Vault (wei), 18 decimals |

**When to use:** Monitor total DSR TVL, track protocol-level savings growth, compare against other yield sources.

---

## Convert sDAI to DAI Value

Preview how much DAI a given amount of sDAI is worth at the current exchange rate. The rate increases over time as DSR yield accrues.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| shares | uint256 | sDAI Shares (wei) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| assets | uint256 | DAI Value (wei), 18 decimals |

**When to use:** Check the current value of sDAI holdings in DAI terms, calculate realized yield, price sDAI for swaps or portfolio tracking.

---

## Example Workflows

### Health Factor Monitor with Discord Alert

`Schedule (every 5 min) -> Spark: Get User Account Data -> Code (healthFactor / 1e18) -> Condition (< 1.5) -> Discord: Send Message`

Monitor your SparkLend health factor and send a Discord alert when it drops below 1.5, giving you time to act before liquidation.

### Auto-Repay on Low Health Factor

`Schedule (every 5 min) -> Spark: Get User Account Data -> Code (healthFactor / 1e18) -> Condition (< 1.2) -> Spark: Repay Debt`

Automatically repay debt when health factor approaches the liquidation threshold. Requires wallet connection and token approval.

### sDAI Savings Monitor

`Schedule (daily) -> Spark: Get sDAI Balance -> Spark: Convert sDAI to DAI Value -> Code (compute yield) -> SendGrid: Send Email`

Track your sDAI position value daily and receive an email summary showing balance, current DAI value, and accrued yield.

### sDAI TVL Tracker with Webhook

`Schedule (hourly) -> Spark: Get sDAI Total Assets -> Code (format TVL) -> Webhook: Send HTTP Request`

Monitor the total DAI locked in the sDAI vault and send hourly updates to an external dashboard or analytics service.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | SparkLend Pool, Pool Data Provider, sDAI |
| Gnosis (100) | SparkLend Pool, Pool Data Provider |

SparkLend uses the same Aave V3 Pool interface for supply, withdraw, borrow, and repay. The sDAI contract is an ERC-4626 vault wrapping DAI in the DAI Savings Rate and is available on Ethereum only (Gnosis uses sxDAI instead).
