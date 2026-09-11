---
title: "Euler V2"
description: "Modular ERC-4626 lending vaults built on the Euler Vault Kit, on Ethereum and Base."
---

# Euler V2

Euler V2 is a modular lending protocol. Rather than one pooled market, it deploys an independent vault per market, each with its own oracle, risk configuration and governor. Every vault is an ERC-4626 vault over a single underlying asset, so supplying to Euler is a vault deposit and the position is held as vault shares. This plugin provides the standard vault operations (deposit, mint, withdraw, redeem) plus Euler-specific reads for liquidity, borrow demand, interest accrual and vault configuration.

Supported chains: Ethereum, Base. Each vault is a separate contract -- you must provide the vault address when configuring actions. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Vault Deposit | Write | Wallet | Deposit assets into an Euler V2 vault and receive shares |
| Vault Mint | Write | Wallet | Mint an exact number of shares by depositing the required assets |
| Vault Withdraw | Write | Wallet | Withdraw assets from a vault by specifying asset amount |
| Vault Redeem | Write | Wallet | Redeem vault shares for underlying assets |
| Vault Underlying Asset | Read | No | Get the address of the underlying asset token |
| Vault Total Assets | Read | No | Get the total underlying assets held by the vault |
| Vault Total Supply | Read | No | Get the total supply of vault shares |
| Vault Share Balance | Read | No | Get the vault share balance of an address |
| Convert Shares to Assets | Read | No | Convert a share amount to its underlying asset value |
| Convert Assets to Shares | Read | No | Convert an asset amount to the equivalent shares |
| Preview Vault Deposit | Read | No | Preview how many shares a deposit would yield |
| Preview Vault Mint | Read | No | Preview how many assets minting shares would cost |
| Preview Vault Withdraw | Read | No | Preview how many shares a withdrawal would burn |
| Preview Vault Redeem | Read | No | Preview how many assets a redemption would yield |
| Max Vault Deposit | Read | No | Get the maximum depositable amount for a receiver |
| Max Vault Mint | Read | No | Get the maximum mintable shares for a receiver |
| Max Vault Withdraw | Read | No | Get the maximum withdrawable amount for an owner |
| Max Vault Redeem | Read | No | Get the maximum redeemable shares for an owner |
| Vault Decimals | Read | No | Get the decimals of the vault share token |
| Available Cash | Read | No | Get the underlying asset held by the vault and available to withdraw or borrow |
| Total Borrows | Read | No | Get the total underlying asset currently borrowed from the vault |
| Borrow Interest Rate | Read | No | Get the current borrow rate as a yield per second, scaled by 10^27 |
| Interest Accumulator | Read | No | Get the vault's monotonic interest accumulator |
| Accumulated Fees | Read | No | Get shares accrued as protocol and governor fees |
| Debt Of Account | Read | No | Get the underlying asset an account owes the vault |
| Vault Oracle | Read | No | Get the price oracle the vault is configured with |
| Unit Of Account | Read | No | Get the asset the vault denominates risk calculations in |
| Vault Connector | Read | No | Get the Ethereum Vault Connector the vault is bound to |
| Vault Creator | Read | No | Get the address that deployed the vault |

---

## Vault Deposit

Deposit underlying assets into an Euler V2 vault and receive vault shares in return. The number of shares received depends on the current exchange rate, which rises as borrowers pay interest. Requires prior token approval for the vault contract.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |
| assets | uint256 | Asset Amount (wei) |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Supply idle assets to an Euler market, automate recurring deposits, move a position into whichever market pays the best supply rate.

---

## Vault Mint

Mint an exact number of vault shares, depositing whatever amount of underlying asset is required at the current exchange rate. Use this when the target is a share count rather than an asset amount.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |
| shares | uint256 | Shares Amount (wei) |
| receiver | address | Receiver Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Match a share position exactly, top a position up to a round share count.

---

## Vault Withdraw

Withdraw a specific amount of underlying assets from an Euler V2 vault, burning the corresponding shares from the owner. A withdrawal is limited by the vault's available cash, so a heavily utilised market may not be able to service the full amount.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |
| assets | uint256 | Asset Amount (wei) |
| receiver | address | Receiver Address |
| owner | address | Share Owner Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Withdraw a target asset amount, automate partial exits on a condition, rotate out of a market whose rate has fallen.

---

## Vault Redeem

Redeem a specific number of vault shares for the underlying assets. The amount received depends on the current exchange rate. Redeeming the full share balance exits the position completely.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |
| shares | uint256 | Shares Amount (wei) |
| receiver | address | Receiver Address |
| owner | address | Share Owner Address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Exit a position entirely without computing the asset amount first, redeem a specific share amount.

---

## Available Cash

Get the amount of underlying asset currently held by the vault and available to withdraw or borrow. Total assets minus cash is what borrowers hold.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| cash | uint256 | Underlying asset available in the vault |

**When to use:** Check a withdrawal will succeed before attempting it, alert when a market's liquidity falls below a threshold.

---

## Total Borrows

Get the total amount of underlying asset currently borrowed from the vault.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalBorrows | uint256 | Underlying asset currently borrowed |

**When to use:** Compute utilisation alongside Available Cash, track borrow demand on a market over time.

---

## Borrow Interest Rate

Get the vault's current borrow interest rate, expressed as a yield per second scaled by 10^27. This is the rate borrowers pay, not the rate suppliers receive; the supply rate is lower by the protocol fee and by the share of the vault sitting as idle cash.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| interestRate | uint256 | Borrow yield per second, scaled by 10^27 |

**When to use:** Compare borrow costs across markets, trigger a workflow when a rate crosses a threshold.

---

## Interest Accumulator

Get the vault's interest accumulator, a monotonically increasing value scaled by 10^27. The ratio between the accumulator at two points in time is the interest factor over that interval, which makes it a more reliable basis for measuring realised yield than sampling a rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| interestAccumulator | uint256 | Monotonic interest accumulator, scaled by 10^27 |

**When to use:** Measure interest actually earned between two runs rather than trusting an instantaneous rate.

---

## Debt Of Account

Get the amount of underlying asset an account currently owes the vault, including accrued interest.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| contractAddress | address | Euler V2 Vault Address |
| account | address | Account Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| debt | uint256 | Underlying asset owed by the account |

**When to use:** Monitor a borrow position, alert when debt grows past a threshold.

---

## Example Workflows

### Supply Rate Monitor

`Schedule (hourly) -> Euler V2: Borrow Interest Rate -> Condition (> threshold) -> Discord: Send Message`

Watch a market's borrow rate and alert when it moves above a threshold.

### Liquidity Guard Before Withdrawal

`Schedule (daily) -> Euler V2: Available Cash -> Condition (>= target) -> Euler V2: Vault Withdraw -> Telegram: Send Message`

Only attempt a withdrawal when the vault holds enough cash to service it, then confirm over Telegram.

### Utilisation Report

`Schedule (daily) -> Euler V2: Available Cash -> Euler V2: Total Borrows -> Math (borrows / (cash + borrows)) -> Slack: Send Message`

Post a daily utilisation figure for a market.

---

## Supported Chains

| Chain | Reference Vault |
|-------|-----------------|
| Ethereum (1) | 0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9 (eUSDC-2) |
| Base (8453) | 0x07954BEB7e137101A7cbb3e47864C684aEC50524 (eUSDC-100) |

Since each Euler V2 market is a separate vault contract, you must provide the vault address when configuring any action. The reference addresses above are used only for chain-availability metadata and as the fixtures the protocol test data binds to.

---

## Technical Notes

Euler V2 vaults are deployed by `GenericFactory` as proxies that carry trailing metadata and dispatch each call to a module by delegatecall. An implementation ABI cannot be resolved through that indirection, so this plugin includes a full inline ABI covering the ERC-4626 interface and the Euler-specific view functions.

The four write functions carry a `callThroughEVC` modifier. When the caller is not the Ethereum Vault Connector, the vault routes the call through the connector itself and re-enters, so a direct call from an ordinary wallet works with no connector awareness on the caller side. Deposits and mints additionally run with no account status check, so supplying to a vault does not require a controller to be enabled. Withdrawals and redemptions are not symmetric with them: both run the account status check against the share owner, so withdrawing on behalf of a third party needs connector authorisation, and even a self-withdrawal can revert while that account has an open Euler borrow.

Vault decimals follow the underlying asset (6 for USDC markets, 18 for WETH markets). Vaults carry a supply cap: once a market reaches it, `maxDeposit` returns zero and the deposit leg reverts. Reading Max Vault Deposit before a deposit is the cheapest way to avoid that.
