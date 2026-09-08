---
title: "Aave V4"
description: "Hub-and-Spoke lending protocol: supply, borrow, repay, manage collateral, and monitor positions via the Lido Spoke on Ethereum."
---

# Aave V4

Aave V4 introduces a Hub-and-Spoke architecture: liquidity lives in Hubs, while users supply, borrow, and manage collateral through Spokes tied to specific ecosystems. Each Spoke has its own set of reserves identified by an opaque `reserveId`, resolved from an asset via the Hub address and the Hub's asset ID. Aave V4 uses a single rate model per reserve, so there is no separate stable/variable borrow mode as in Aave V3.

This plugin currently exposes the Lido Spoke, one of Aave V4's launch Spokes. Additional Spokes can be added as the protocol matures.

Supported chains: Ethereum. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Supply Asset | Write | Wallet | Supply an asset to the Aave V4 Lido Spoke to earn interest |
| Withdraw Asset | Write | Wallet | Withdraw a supplied asset from the Aave V4 Lido Spoke |
| Borrow Asset | Write | Wallet | Borrow an asset against supplied collateral |
| Repay Debt | Write | Wallet | Repay a borrowed asset |
| Set Asset as Collateral | Write | Wallet | Enable or disable a supplied reserve as collateral |
| Get Reserve ID | Read | No | Resolve an asset to its reserveId within the Spoke |
| Get User Supplied Assets | Read | No | Get the amount of underlying asset supplied by a user for a reserve |
| Get User Debt | Read | No | Get a user's drawn and premium debt for a reserve |
| Get User Account Data | Read | No | Get overall account health, collateral, debt, and risk premium |

---

## Supply Asset

Supply an asset to the Aave V4 Lido Spoke to earn interest. Amount is in the underlying asset's smallest unit (wei for 18-decimal tokens).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| reserveId | uint256 | Reserve ID (resolve first with Get Reserve ID) |
| amount | uint256 | Amount (wei) |
| onBehalfOf | address | On Behalf Of Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Earn yield on idle tokens, automate deposits into the Lido Spoke, build supply strategies keyed off reserve identifiers.

---

## Withdraw Asset

Withdraw a supplied asset from the Aave V4 Lido Spoke.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| reserveId | uint256 | Reserve ID |
| amount | uint256 | Amount (wei) |
| onBehalfOf | address | Recipient Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Withdraw funds when needed, automate withdrawals based on rate changes, rebalance collateral positions.

---

## Borrow Asset

Borrow an asset from the Aave V4 Lido Spoke against supplied collateral. V4 uses a single rate model, so there is no interest rate mode input.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| reserveId | uint256 | Reserve ID |
| amount | uint256 | Amount (wei) |
| onBehalfOf | address | On Behalf Of Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Borrow against collateral, leverage positions, automate borrowing based on market conditions.

---

## Repay Debt

Repay a borrowed asset to the Aave V4 Lido Spoke.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| reserveId | uint256 | Reserve ID |
| amount | uint256 | Amount (wei) |
| onBehalfOf | address | On Behalf Of Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Automate debt repayment when health factor drops, repay before liquidation, scheduled debt reduction.

---

## Set Asset as Collateral

Enable or disable a supplied reserve as collateral in the Aave V4 Lido Spoke. There is no partial collateral in V4: this toggles the entire supplied balance of the reserve.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| reserveId | uint256 | Reserve ID |
| usingAsCollateral | bool | Use as Collateral |
| onBehalfOf | address | On Behalf Of Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Manage collateral exposure, disable a reserve as collateral during market uncertainty, optimize borrow capacity.

---

## Get Reserve ID

Resolve an asset to its `reserveId` within the Lido Spoke, given the Hub address and the Hub's asset ID for that asset. Call this before Supply, Withdraw, Borrow, Repay, or Set Asset as Collateral.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| hub | address | Hub Address |
| assetId | uint256 | Hub Asset ID (resolve via the Hub's `getAssetId(underlying)`) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| reserveId | uint256 | Reserve ID |

**When to use:** Look up the reserveId for a token before running any Spoke action against it.

---

## Get User Supplied Assets

Get the amount of underlying asset supplied by a user for a given reserve.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| reserveId | uint256 | Reserve ID |
| user | address | User Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| suppliedAmount | uint256 | Supplied Amount (underlying) |

**When to use:** Monitor individual reserve positions, track supplied balances across reserves.

---

## Get User Debt

Get the debt of a user for a given reserve, split into drawn debt and premium debt. Total debt is drawn plus premium.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| reserveId | uint256 | Reserve ID |
| user | address | User Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| drawnDebt | uint256 | Drawn Debt (underlying) |
| premiumDebt | uint256 | Premium Debt (underlying) |

**When to use:** Monitor outstanding debt per reserve, compare drawn vs. premium debt, plan repayments.

---

## Get User Account Data

Get overall account health, including collateral value, debt, health factor, and risk premium. Returns a struct; access individual fields via a dotted path (for example `result.healthFactor`).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| user | address | User Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| accountData | struct | riskPremium, avgCollateralFactor, healthFactor, totalCollateralValue, totalDebtValueRay, activeCollateralCount, borrowCount |

**When to use:** Monitor account health factor for liquidation protection, check borrow capacity before opening new positions, track portfolio-level collateral and debt.

---

## Example Workflows

### Health Factor Monitor with Alert

`Schedule (every 5 min) -> Aave V4: Get User Account Data -> Code (accountData.healthFactor / 1e18) -> Condition (< 1.5) -> Discord: Send Message`

Monitor your Aave V4 Lido Spoke health factor and send a Discord alert when it drops below 1.5, giving you time to act before liquidation.

### Supply After Resolving Reserve ID

`Manual -> Aave V4: Get Reserve ID -> Aave V4: Supply Asset`

Resolve the reserveId for an asset from its Hub address and asset ID, then supply that asset to the Lido Spoke in the same workflow.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | Aave V4 Lido Spoke |

Aave V4 launched on Ethereum mainnet with a Hub-and-Spoke architecture. This plugin exposes the Lido Spoke; the full, current action list for this protocol is available in the app's action grid and via the `search_protocol_actions` MCP tool.
