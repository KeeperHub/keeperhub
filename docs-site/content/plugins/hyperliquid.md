---
title: "Hyperliquid Plugin"
description: "Read-only Info API queries for Hyperliquid vault operators, validators, and trader account state."
---

# Hyperliquid Plugin

Query the Hyperliquid Info REST API directly from a workflow. Useful for vault operator reporting (LP statements, AUM reconciliation, fee accounting), validator monitoring, and trader account state lookups. No credentials required -- all endpoints are public.

All actions POST to `https://api.hyperliquid.xyz/info` with a `type` discriminator and return the response JSON in the `data` output field.

## Actions

| Action | Description |
|--------|-------------|
| Get Clearinghouse State | User's perpetuals account: positions, margin, account value |
| Get Vault Details | Vault metadata: leader, portfolio, APR, followers, equity |
| Get Validator Summaries | All validators: stake, jailed status, commission, uptime |
| Get Funding History | Historical funding rate records for a coin |
| Get Spot Deploy State | Spot token deployment auction state and gas auction |
| Get Referral State | Referral status, volume, claimed/unclaimed rewards |
| Get Sub-Accounts | All sub-accounts for a master user |
| Get Active Asset Data | User's per-coin leverage, max trade sizes, mark price |

## Get Clearinghouse State

Returns a user's perpetuals account summary on the standard Hyperliquid exchange or a builder-deployed perp DEX.

**Inputs:** User Address (required), Builder DEX (optional, for HIP-3 builder-deployed perps)

**Outputs:** `success`, `data` (marginSummary, assetPositions, withdrawable, time), `error`

**When to use:** Position monitoring, margin alerts, account-value snapshots for LP statements.

## Get Vault Details

Returns vault metadata and (optionally) a specific user's relationship to the vault.

**Inputs:** Vault Address (required), User Address (optional)

**Outputs:** `success`, `data` (name, leader, vaultAddress, portfolio, apr, followers, relationship), `error`

**When to use:** Monthly LP statements for vault followers, AUM reconciliation, concentration-risk digests.

## Get Validator Summaries

Returns summaries for every validator on Hyperliquid.

**Inputs:** None

**Outputs:** `success`, `data` (array of validators with stake, isJailed, isActive, commission, uptime stats), `error`

**When to use:** Validator uptime monitoring, stake distribution snapshots, jailing alerts.

## Get Funding History

Returns historical funding rate records for a coin between two timestamps.

**Inputs:** Coin (required, e.g. `BTC`), Start Time in ms (required), End Time in ms (optional)

**Outputs:** `success`, `data` (array of `{coin, fundingRate, premium, time}`), `error`

**When to use:** Funding rate digests, hedging-cost reporting, basis-trade signal generation.

## Get Spot Deploy State

Returns spot token deployment auction state and the gas auction parameters.

**Inputs:** User Address (required)

**Outputs:** `success`, `data` (states array + gasAuction with start, duration, gas params), `error`

**When to use:** Spot deploy auction monitoring, HIP-1 listing alerts.

## Get Referral State

Returns a user's referral status, volume, rewards, and referee list.

**Inputs:** User Address (required)

**Outputs:** `success`, `data` (referredBy, cumVlm, unclaimedRewards, claimedRewards, referrerState), `error`

**When to use:** Referral reward accounting, referee growth reporting.

## Get Sub-Accounts

Returns all sub-accounts owned by a master address, each with its own clearinghouse state.

**Inputs:** Master Address (required)

**Outputs:** `success`, `data` (array of `{name, subAccountUser, master, clearinghouseState}`), `error`

**When to use:** Multi-account treasury reporting, sub-account margin aggregation.

## Get Active Asset Data

Returns a user's per-coin trading context: leverage, max trade sizes, available balance, mark price.

**Inputs:** User Address (required), Coin (required, e.g. `BTC`)

**Outputs:** `success`, `data` (user, coin, leverage, maxTradeSzs, availableToTrade, markPx), `error`

**When to use:** Pre-trade headroom checks, leverage drift alerts, per-asset risk digests.

## Example workflow

```
Schedule (daily at 09:00 UTC)
  -> Get Vault Details (HLP vault address)
  -> Get Sub-Accounts (vault leader address)
  -> Code: format monthly LP statement
  -> SendGrid: email statement to LP list
```
