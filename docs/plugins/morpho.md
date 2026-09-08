---
title: "Morpho"
description: "Trustless lending protocol -- supply, borrow, repay, liquidate, position tracking, and market monitoring on Ethereum and Base."
---

# Morpho

Morpho is a trustless, permissionless lending protocol deployed as a singleton contract. It enables overcollateralized borrowing and lending of ERC-20 tokens through isolated markets, each defined by a loan token, collateral token, oracle, interest rate model, and liquidation LTV.

This plugin provides actions for the full lending lifecycle: supplying and withdrawing loan tokens, borrowing and repaying against collateral, managing collateral positions, liquidating unhealthy positions, monitoring market state, and managing authorization. Read-only actions work without credentials. Write actions require a connected wallet. Actions that take MarketParams (supply, withdraw, borrow, repay, collateral, liquidate, accrue-interest) accept the 5 struct fields as flat inputs; the runtime reshapes them into the Solidity tuple automatically.

Supported chains: Ethereum (1), Base (8453).

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Position | Read | No | Check a user's supply shares, borrow shares, and collateral in a market |
| Get Market | Read | No | Check total supply, borrows, last update time, and fee for a market |
| Get Market Params | Read | No | Resolve a market ID to its loan token, collateral, oracle, IRM, and LLTV |
| Check Authorization | Read | No | Check if an address is authorized to act on behalf of another |
| Set Authorization | Write | Wallet | Grant or revoke authorization for another address |
| Flash Loan | Write | Wallet | Borrow tokens and repay within the same transaction |
| Supply | Write | Wallet | Supply loan tokens to a market |
| Withdraw | Write | Wallet | Withdraw supplied loan tokens from a market |
| Borrow | Write | Wallet | Borrow loan tokens against deposited collateral |
| Repay | Write | Wallet | Repay borrowed loan tokens |
| Supply Collateral | Write | Wallet | Deposit collateral tokens into a market |
| Withdraw Collateral | Write | Wallet | Remove collateral tokens from a position |
| Liquidate | Write | Wallet | Liquidate an undercollateralized position |
| Accrue Interest | Write | Wallet | Trigger interest accrual for a market |

---

## Get Position

Check a user's supply shares, borrow shares, and collateral in a Morpho market. Markets are identified by their bytes32 market ID (keccak256 hash of MarketParams).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| id | bytes32 | Market ID |
| user | address | User Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| supplyShares | uint256 | Supply Shares |
| borrowShares | uint128 | Borrow Shares |
| collateral | uint128 | Collateral |

**When to use:** Monitor lending positions, track collateral health, trigger alerts when positions approach liquidation thresholds.

---

## Get Market

Check total supply, borrows, last update time, and fee for a Morpho market.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| id | bytes32 | Market ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupplyAssets | uint128 | Total Supply Assets |
| totalSupplyShares | uint128 | Total Supply Shares |
| totalBorrowAssets | uint128 | Total Borrow Assets |
| totalBorrowShares | uint128 | Total Borrow Shares |
| lastUpdate | uint128 | Last Update Timestamp |
| fee | uint128 | Fee |

**When to use:** Monitor market utilization, track total supply and borrow volumes, calculate interest rates from supply/borrow ratios.

---

## Get Market Params

Resolve a market ID to its full parameters: loan token, collateral token, oracle address, interest rate model, and liquidation LTV.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| id | bytes32 | Market ID |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| loanToken | address | Loan Token |
| collateralToken | address | Collateral Token |
| oracle | address | Oracle |
| irm | address | Interest Rate Model |
| lltv | uint256 | Liquidation LTV |

**When to use:** Discover market configuration, verify market parameters before interacting, build market dashboards.

---

## Check Authorization

Check if an address is authorized to act on behalf of another in Morpho. Authorization is required for bundler contracts and delegation patterns.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| authorizer | address | Authorizer Address |
| authorized | address | Authorized Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| isAuthorized | bool | Is Authorized |

**When to use:** Verify bundler authorization before executing batched operations, check delegation status for managed positions.

---

## Set Authorization

Grant or revoke authorization for another address to act on your behalf in Morpho. Required before using bundler contracts for batched supply, borrow, or other operations.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| authorized | address | Authorized Address |
| newIsAuthorized | bool | Authorize |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Authorize the Morpho bundler before batched operations, set up delegation for managed positions, revoke access when no longer needed.

---

## Flash Loan

Borrow tokens and repay within the same transaction via Morpho flash loan. The callback data parameter encodes the operations to perform with the borrowed funds.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| token | address | Token Address |
| assets | uint256 | Amount (wei) |
| data | bytes | Callback Data |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Execute arbitrage, perform liquidations with borrowed capital, rebalance positions atomically.

---

## Supply

Supply loan tokens to a Morpho market. Specify the amount in assets or shares (set the other to 0). The MarketParams fields identify which market to supply to.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |
| assets | uint256 | Asset Amount |
| shares | uint256 | Share Amount (default: 0) |
| onBehalf | address | On Behalf Of |
| data | bytes | Callback Data (default: 0x) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Deposit idle tokens to earn yield, automate periodic supply into high-utilization markets, rebalance across markets.

---

## Withdraw

Withdraw supplied loan tokens from a Morpho market. Specify the amount in assets or shares (set the other to 0).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |
| assets | uint256 | Asset Amount |
| shares | uint256 | Share Amount (default: 0) |
| onBehalf | address | On Behalf Of |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit lending positions, withdraw funds when utilization drops, automate withdrawals based on rate conditions.

---

## Borrow

Borrow loan tokens from a Morpho market against deposited collateral. Specify the amount in assets or shares (set the other to 0).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |
| assets | uint256 | Asset Amount |
| shares | uint256 | Share Amount (default: 0) |
| onBehalf | address | On Behalf Of |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Leverage collateral positions, automate borrowing when rates are favorable, open leveraged yield strategies.

---

## Repay

Repay borrowed loan tokens to a Morpho market. Specify the amount in assets or shares (set the other to 0).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |
| assets | uint256 | Asset Amount |
| shares | uint256 | Share Amount (default: 0) |
| onBehalf | address | On Behalf Of |
| data | bytes | Callback Data (default: 0x) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Reduce debt before liquidation, automate partial repayments, close borrow positions entirely.

---

## Supply Collateral

Deposit collateral tokens into a Morpho market for borrowing.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |
| assets | uint256 | Collateral Amount |
| onBehalf | address | On Behalf Of |
| data | bytes | Callback Data (default: 0x) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Prepare collateral before borrowing, top up collateral to avoid liquidation, automate collateral management.

---

## Withdraw Collateral

Remove collateral tokens from a Morpho market position.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |
| assets | uint256 | Collateral Amount |
| onBehalf | address | On Behalf Of |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Free excess collateral, rebalance collateral across markets, exit positions after repaying debt.

---

## Liquidate

Liquidate an undercollateralized position in a Morpho market. Specify either seized collateral amount or repaid shares (set the other to 0).

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |
| borrower | address | Borrower Address |
| seizedAssets | uint256 | Seized Collateral Amount |
| repaidShares | uint256 | Repaid Shares (default: 0) |
| data | bytes | Callback Data (default: 0x) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Run a liquidation keeper bot, automate liquidations when positions become unhealthy, earn liquidation incentives.

---

## Accrue Interest

Trigger interest accrual for a Morpho market to update supply and borrow indices. This is a public function anyone can call.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| loanToken | address | Loan Token Address |
| collateralToken | address | Collateral Token Address |
| oracle | address | Oracle Address |
| irm | address | IRM Address |
| lltv | uint256 | Liquidation LTV |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Force index updates before reading accurate balances, ensure interest is accrued before liquidation checks.

---

## Example Workflows

### Monitor Position Health

`Schedule (hourly) -> Morpho: Get Position -> Condition (collateral < threshold) -> Discord: Send Message`

Periodically check a lending position's collateral level and send an alert if it drops below a safety threshold.

### Track Market Utilization

`Schedule (daily) -> Morpho: Get Market -> Math (totalBorrowAssets / totalSupplyAssets) -> Condition (> 0.9) -> Telegram: Send Message`

Monitor a market's utilization ratio and alert when it exceeds 90%, indicating high borrow demand.

### Authorization Check Before Bundler Use

`Manual -> Morpho: Check Authorization -> Condition (isAuthorized = false) -> Morpho: Set Authorization`

Verify bundler authorization status and automatically grant it if not already set. Prepares the wallet for batched Morpho operations.

### Auto-Supply on High Utilization

`Schedule (hourly) -> Morpho: Get Market -> Math (totalBorrowAssets / totalSupplyAssets) -> Condition (> 0.85) -> Morpho: Supply`

Monitor market utilization and automatically supply tokens when borrow demand is high, capturing elevated interest rates.

### Liquidation Keeper Bot

`Schedule (every 5 min) -> Morpho: Get Position (target borrower) -> Condition (collateral < threshold) -> Morpho: Liquidate -> Discord: Send Message`

Monitor an undercollateralized borrower and automatically liquidate when their position becomes unhealthy. Send a notification on execution.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | Morpho Blue |
| Base (8453) | Morpho Blue |

Morpho Blue uses the same singleton contract address on both chains. All markets on each chain are accessed through this single contract.
