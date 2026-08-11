---
title: "Compound V3"
description: "Lending protocol -- supply assets, borrow base tokens, and monitor balances across isolated Comet markets on Ethereum, Base, and Arbitrum."
---

# Compound V3

Compound V3 (Comet) is a decentralized lending protocol with isolated markets. Each Comet market has a single borrowable base asset (e.g. USDC) and multiple collateral assets. Users supply collateral to borrow the base asset, or supply the base asset to earn interest. This plugin provides actions for core lending operations and balance monitoring.

Supported chains: Ethereum, Base, Arbitrum. Each Comet market is a separate contract -- you specify the market address when configuring actions. Read-only actions work without credentials. Write actions require a connected wallet.

## Comet Market Addresses

Each Comet market is a standalone contract. Common markets:

| Chain | Base Asset | Comet Address |
|-------|-----------|---------------|
| Ethereum (1) | USDC | 0xc3d688B66703497DAA19211EEdff47f25384cdc3 |
| Ethereum (1) | USDT | 0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840 |
| Ethereum (1) | WETH | 0xA17581A9E3356d9A858b789D68B4d866e593aE94 |
| Base (8453) | USDC | 0xb125E6687d4313864e53df431d5425969c15Eb2F |
| Base (8453) | USDbC | 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf |
| Base (8453) | WETH | 0x46e6b214b524310239732D51387075E0e70970bf |
| Arbitrum (42161) | USDC | 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf |
| Arbitrum (42161) | USDT | 0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07 |
| Arbitrum (42161) | WETH | 0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486 |

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Supply Asset | Write | Wallet | Supply base or collateral assets to a Comet market |
| Withdraw Asset | Write | Wallet | Withdraw base or collateral assets from a Comet market |
| Get Base Balance | Read | No | Get the base asset balance for an account |
| Get Collateral Balance | Read | No | Get a collateral asset balance for an account |
| Get Borrow Balance | Read | No | Get the borrow balance for an account |
| Get Utilization | Read | No | Get the current utilization rate of a market |
| Get Supply Rate | Read | No | Get the per-second supply rate for a utilization level |
| Get Borrow Rate | Read | No | Get the per-second borrow rate for a utilization level |
| Get Total Supply | Read | No | Get total base asset supplied across all users |
| Get Total Borrow | Read | No | Get total base asset borrowed across all users |
| Is Liquidatable | Read | No | Check if an account is currently liquidatable |
| Get Number of Assets | Read | No | Get the number of supported collateral assets |

---

## Supply Asset

Supply base or collateral assets to a Compound V3 Comet market. Requires prior ERC-20 approval for the Comet contract. Supplying the base asset earns interest. Supplying a collateral asset enables borrowing.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| amount | uint256 | Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Earn yield on stablecoins, deposit collateral before borrowing, automate deposits when conditions are met.

---

## Withdraw Asset

Withdraw base or collateral assets from a Compound V3 Comet market. Ensure withdrawing collateral does not make the position liquidatable.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| asset | address | Asset Token Address |
| amount | uint256 | Amount (wei) |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Withdraw funds when needed, reduce collateral exposure, automate withdrawals based on rate changes.

---

## Get Base Balance

Get the balance of the base asset (e.g. USDC) for an account in a Comet market. Returns the current lending balance including accrued interest.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Account Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Base Asset Balance (raw, decimals vary by market) |

**When to use:** Monitor supply positions, check earned interest, trigger actions based on balance thresholds.

---

## Get Collateral Balance

Get the collateral balance of a specific asset for an account in a Comet market.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Account Address |
| asset | address | Collateral Asset Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Collateral Balance |

**When to use:** Monitor collateral positions, check if collateral needs topping up, track portfolio exposure.

---

## Get Borrow Balance

Get the borrow balance of the base asset for an account in a Comet market. Returns the current outstanding debt including accrued interest.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Account Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Borrow Balance (raw, decimals vary by market) |

**When to use:** Monitor outstanding debt, trigger repayment workflows, track borrowing costs.

---

## Get Utilization

Get the current utilization rate of a Comet market (ratio of borrows to supply, scaled to 1e18).

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| utilization | uint256 | Utilization Rate (18 decimals) |

**When to use:** Monitor market health, feed into supply/borrow rate calculations, trigger actions when utilization crosses a threshold.

---

## Get Supply Rate

Get the per-second supply rate for a given utilization level. Multiply by 31536000 for annualized APR.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| utilization | uint256 | Utilization (from Get Utilization) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| rate | uint64 | Supply Rate Per Second |

**When to use:** Compare yield across markets, trigger rebalancing when rates change, monitor APR trends.

---

## Get Borrow Rate

Get the per-second borrow rate for a given utilization level. Multiply by 31536000 for annualized APR.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| utilization | uint256 | Utilization (from Get Utilization) |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| rate | uint64 | Borrow Rate Per Second |

**When to use:** Monitor borrowing costs, trigger repayment when rates spike, compare across markets.

---

## Get Total Supply

Get the total base asset supplied to a Comet market across all users.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint256 | Total Supply (raw, decimals vary by market) |

**When to use:** Monitor market depth, detect large supply changes, assess market liquidity.

---

## Get Total Borrow

Get the total base asset borrowed from a Comet market across all users.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalBorrow | uint256 | Total Borrow (raw, decimals vary by market) |

**When to use:** Monitor market demand, detect borrow spikes, assess protocol risk.

---

## Is Liquidatable

Check if an account is currently liquidatable in a Comet market.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Account Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| isLiquidatable | bool | Is Liquidatable |

**When to use:** Monitor position health, trigger alerts before liquidation, build liquidation bots.

---

## Get Number of Assets

Get the number of collateral assets supported by a Comet market.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| numAssets | uint8 | Number of Collateral Assets |

**When to use:** Enumerate supported collaterals, detect new asset additions.

---

## Example Workflows

### Supply Balance Monitor

`Schedule (every hour) -> Compound V3: Get Base Balance -> Condition (balance < threshold) -> Discord: Send Message`

Monitor your supply balance in a Comet market and alert when it drops below a threshold, which could indicate unexpected withdrawals or liquidation.

### Borrow Position Monitor

`Schedule (every 5 min) -> Compound V3: Get Borrow Balance -> Code (format balance) -> Condition (balance > limit) -> Discord: Send Message`

Track your borrow balance and get notified when outstanding debt exceeds a limit, giving you time to repay before the position becomes risky.

### Auto-Supply on Deposit

`Webhook (receive deposit notification) -> Compound V3: Supply Asset`

Automatically supply received assets to a Comet market to start earning interest immediately.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | Comet (user-specified market address) |
| Base (8453) | Comet (user-specified market address) |
| Arbitrum (42161) | Comet (user-specified market address) |

Each Comet market is a separate contract. You specify the market address when configuring actions. See the Comet Market Addresses table above for common market contracts.
