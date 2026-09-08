---
title: "Sky Protocol"
description: "USDS savings (sUSDS), USDS staking (stUSDS), token balances, approvals, and DAI/MKR migration converters on Ethereum, Base, and Arbitrum."
---

# Sky Protocol

Sky (formerly MakerDAO) is a decentralized protocol for stablecoin savings, governance, and token migration. This plugin exposes two ERC-4626 vaults (the sUSDS savings vault and the stUSDS staked vault), token balance and approval actions for USDS, DAI, and SKY, and converters for migrating legacy DAI to USDS and legacy MKR to SKY.

Supported chains: Ethereum (all contracts), Base (sUSDS, USDS), Arbitrum (sUSDS, USDS). Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

Sky is a multi-contract protocol, so actions are grouped below by the contract that exposes them. Each vault (sUSDS and stUSDS) is a standard ERC-4626 vault and exposes the same 18 vault actions; stUSDS uses a `st-usds-` slug prefix and a "stUSDS" label prefix to distinguish it from the sUSDS vault.

### sUSDS Savings Vault

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Vault Deposit | `vault-deposit` | Write | Deposit assets into the vault and receive shares |
| Vault Mint | `vault-mint` | Write | Mint exact vault shares by depositing the required amount of assets |
| Vault Withdraw | `vault-withdraw` | Write | Withdraw assets from the vault by specifying asset amount |
| Vault Redeem | `vault-redeem` | Write | Redeem shares from the vault for underlying assets |
| Vault Underlying Asset | `vault-asset` | Read | Get the address of the underlying asset token for this vault |
| Vault Total Assets | `vault-total-assets` | Read | Get the total amount of underlying assets held by the vault |
| Vault Total Supply | `vault-total-supply` | Read | Get the total supply of vault shares |
| Vault Share Balance | `vault-balance` | Read | Get the vault share balance of an address |
| Convert Shares to Assets | `vault-convert-to-assets` | Read | Convert a vault share amount to its underlying asset value at the current rate |
| Convert Assets to Shares | `vault-convert-to-shares` | Read | Convert an asset amount to the equivalent vault shares at the current rate |
| Preview Vault Deposit | `vault-preview-deposit` | Read | Preview how many shares a given asset deposit would yield |
| Preview Vault Mint | `vault-preview-mint` | Read | Preview how many assets are needed to mint a given number of shares |
| Preview Vault Withdraw | `vault-preview-withdraw` | Read | Preview how many shares must be burned to withdraw a given asset amount |
| Preview Vault Redeem | `vault-preview-redeem` | Read | Preview how many assets a given share redemption would yield |
| Max Vault Deposit | `vault-max-deposit` | Read | Get the maximum amount of assets that can be deposited for a receiver |
| Max Vault Mint | `vault-max-mint` | Read | Get the maximum number of shares that can be minted for a receiver |
| Max Vault Withdraw | `vault-max-withdraw` | Read | Get the maximum amount of assets that can be withdrawn by an owner |
| Max Vault Redeem | `vault-max-redeem` | Read | Get the maximum number of shares that can be redeemed by an owner |

Available on Ethereum, Base, and Arbitrum.

### stUSDS Staked Vault

Same 18 actions as the sUSDS vault above, with a `st-usds-` slug prefix and a "stUSDS" label prefix, for example "stUSDS Vault Deposit" (`st-usds-vault-deposit`) and "stUSDS Vault Share Balance" (`st-usds-vault-balance`). Use the "stUSDS Vault Underlying Asset" (`st-usds-vault-asset`) action to read which token the staked vault wraps. Available on Ethereum only.

### USDS Stablecoin

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Get USDS Balance | `get-usds-balance` | Read | Check the USDS balance of an address |
| Approve USDS Spending | `approve-usds` | Write | Approve a spender to transfer USDS on your behalf |

Available on Ethereum, Base, and Arbitrum.

### DAI Stablecoin (Legacy)

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Get DAI Balance | `get-dai-balance` | Read | Check the DAI balance of an address |
| Approve DAI Spending | `approve-dai` | Write | Approve a spender to transfer DAI on your behalf |

Ethereum only.

### SKY Governance Token

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Get SKY Balance | `get-sky-balance` | Read | Check the SKY balance of an address |

Ethereum only.

### DAI-USDS Converter

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Convert DAI to USDS | `convert-dai-to-usds` | Write | Convert DAI to USDS at a 1:1 rate via the official converter |
| Convert USDS to DAI | `convert-usds-to-dai` | Write | Convert USDS back to DAI at a 1:1 rate via the official converter |

Ethereum only. Requires prior DAI or USDS approval for the converter contract (use Approve DAI Spending / Approve USDS Spending).

### MKR-SKY Converter

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Convert MKR to SKY | `convert-mkr-to-sky` | Write | Convert MKR governance tokens to SKY via the official converter (one-way) |

Ethereum only. Requires prior MKR approval for the converter contract.

---

## Example Workflows

### Monitor USDS Balance with Alert

`Schedule (daily) -> Sky: Get USDS Balance -> Math (Sum, divide by 1e18) -> Condition (< 100) -> Discord: Send Message`

Check your USDS balance daily, convert from wei to decimal, and send a Discord alert if it drops below 100 USDS.

### Auto-Deposit Idle USDS into Savings

`Schedule (hourly) -> Sky: Get USDS Balance -> Math (Sum, divide by 1e18) -> Condition (> 500) -> Sky: Approve USDS Spending -> Sky: Vault Deposit`

Periodically check for idle USDS and automatically deposit into the sUSDS savings vault when the balance exceeds a threshold. Requires wallet connection.

### Track Savings Yield

`Schedule (daily) -> Sky: Vault Share Balance -> Sky: Convert Shares to Assets -> Math (Sum, divide by 1e18) -> Webhook: Send HTTP Request`

Monitor your sUSDS position, convert shares to their current USDS value, and send the result to an external webhook for portfolio tracking.

### DAI Migration Pipeline

`Manual -> Sky: Get DAI Balance -> Math (Sum, divide by 1e18) -> Condition (> 0) -> Sky: Approve DAI Spending -> Sky: Convert DAI to USDS -> Sky: Vault Deposit`

One-click migration of DAI holdings: check balance, approve the converter, convert to USDS, and deposit into the sUSDS savings vault. Ethereum only.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | sUSDS Savings Vault, stUSDS Staked Vault, USDS, DAI, SKY, DAI-USDS Converter, MKR-SKY Converter |
| Base (8453) | sUSDS Savings Vault, USDS |
| Arbitrum (42161) | sUSDS Savings Vault, USDS |

The sUSDS savings vault and USDS stablecoin are available on all three chains. The stUSDS staked vault, DAI, SKY, and the converter contracts are Ethereum-only.
