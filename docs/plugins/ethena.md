---
title: "Ethena"
description: "sUSDe staking vault (ERC-4626), USDe stablecoin, and ENA governance token on Ethereum."
---

# Ethena

Ethena is the protocol behind USDe, a synthetic dollar, and sUSDe, an ERC-4626 vault that stakes USDe to earn protocol yield. Exiting sUSDe normally goes through a cooldown period: initiate a cooldown for a specific asset or share amount, wait for the cooldown duration to elapse, then unstake to claim the underlying USDe. This plugin also exposes balance checks for the USDe stablecoin and the ENA governance token.

Supported chains: Ethereum. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

Actions are grouped below by contract: the sUSDe staking vault, the USDe stablecoin, and the ENA governance token.

### sUSDe Staking Vault

The 18 standard ERC-4626 vault actions, plus Ethena-specific cooldown actions.

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Vault Deposit | `vault-deposit` | Write | Deposit USDe into the vault and receive sUSDe shares |
| Vault Mint | `vault-mint` | Write | Mint exact sUSDe shares by depositing the required amount of USDe |
| Vault Withdraw | `vault-withdraw` | Write | Withdraw USDe from the vault by specifying asset amount |
| Vault Redeem | `vault-redeem` | Write | Redeem sUSDe shares for USDe |
| Vault Underlying Asset | `vault-asset` | Read | Get the address of the underlying asset token (USDe) |
| Vault Total Assets | `vault-total-assets` | Read | Get the total amount of USDe held by the vault |
| Vault Total Supply | `vault-total-supply` | Read | Get the total supply of sUSDe shares |
| Vault Share Balance | `vault-balance` | Read | Get the sUSDe share balance of an address |
| Convert Shares to Assets | `vault-convert-to-assets` | Read | Convert a sUSDe share amount to its USDe value at the current rate |
| Convert Assets to Shares | `vault-convert-to-shares` | Read | Convert a USDe amount to the equivalent sUSDe shares at the current rate |
| Preview Vault Deposit | `vault-preview-deposit` | Read | Preview how many shares a given USDe deposit would yield |
| Preview Vault Mint | `vault-preview-mint` | Read | Preview how much USDe is needed to mint a given number of shares |
| Preview Vault Withdraw | `vault-preview-withdraw` | Read | Preview how many shares must be burned to withdraw a given USDe amount |
| Preview Vault Redeem | `vault-preview-redeem` | Read | Preview how much USDe a given share redemption would yield |
| Max Vault Deposit | `vault-max-deposit` | Read | Get the maximum USDe amount that can be deposited for a receiver |
| Max Vault Mint | `vault-max-mint` | Read | Get the maximum number of shares that can be minted for a receiver |
| Max Vault Withdraw | `vault-max-withdraw` | Read | Get the maximum USDe amount that can be withdrawn by an owner |
| Max Vault Redeem | `vault-max-redeem` | Read | Get the maximum number of shares that can be redeemed by an owner |
| Cooldown Assets | `cooldown-assets` | Write | Initiate the cooldown period to unstake a specific amount of USDe |
| Cooldown Shares | `cooldown-shares` | Write | Initiate the cooldown period to unstake a specific number of sUSDe shares |
| Unstake (Claim After Cooldown) | `unstake` | Write | Claim USDe after the cooldown period has elapsed |
| Get Cooldown Duration | `get-cooldown-duration` | Read | Get the current cooldown duration in seconds required before unstaking |
| Get Cooldown Status | `get-cooldown-status` | Read | Get the cooldown end timestamp and USDe amount pending for an address |

Vault Withdraw and Vault Redeem revert while sUSDe's cooldown mode is active, which is the default. Use Cooldown Assets or Cooldown Shares followed by Unstake to exit a staking position instead.

### USDe Stablecoin

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Get USDe Balance | `get-usde-balance` | Read | Check the USDe stablecoin balance of an address |
| Approve USDe Spending | `approve-usde` | Write | Approve a spender to transfer USDe. Required before depositing into the sUSDe vault |

### ENA Governance Token

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Get ENA Balance | `get-ena-balance` | Read | Check the ENA governance token balance of an address |

---

## Example Workflows

### Auto-Stake Idle USDe

`Schedule (hourly) -> Ethena: Get USDe Balance -> Math (Sum, divide by 1e18) -> Condition (> 100) -> Ethena: Approve USDe Spending -> Ethena: Vault Deposit`

Check for idle USDe and stake it into sUSDe when the balance exceeds a threshold.

### Cooldown and Unstake Pipeline

`Manual -> Ethena: Cooldown Shares -> Ethena: Get Cooldown Status -> Condition (cooldownEnd elapsed) -> Ethena: Unstake`

Start a cooldown on a share amount, monitor its status, and unstake once the cooldown period has elapsed.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | sUSDe Staking Vault, USDe, ENA |

The full, current action list for this protocol is available in the app's action grid and via the `search_protocol_actions` MCP tool.
