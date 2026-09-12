---
title: "Coinbase cbETH"
description: "Coinbase Wrapped Staked ETH (cbETH) reads on Ethereum mainnet: the on-chain exchange rate, a balance, the total supply."
---

# Coinbase cbETH

cbETH is Coinbase Wrapped Staked ETH, a non-rebasing ERC20 representing staked ETH held with Coinbase. Balances do not grow. Value accrues through an on-chain exchange rate that only ratchets up as staking rewards land, so one cbETH is worth progressively more ETH over time.

This plugin is read-only. The token is a FiatToken-style proxy, so its implementation does carry `mint` and `burn`, but minting is minter-gated and cannot be called by an integrator, while burning destroys tokens without redeeming ETH. Neither makes a useful workflow action, so the three reads are the whole surface.

Supported chains: Ethereum Mainnet only, at `0xBe9895146f7AF43049ca1c1AE358B0541Ea49704`. No credentials are needed for any action.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get cbETH Exchange Rate | Read | No | Read the current ETH value of one cbETH |
| Get cbETH Balance | Read | No | Check the cbETH balance of an address |
| Get cbETH Total Supply | Read | No | Get total cbETH in circulation |

---

## Get cbETH Exchange Rate

Read the current ETH value of one cbETH. The rate only ratchets up as staking rewards accrue.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| rate | uint256 | Exchange Rate (wei of ETH per cbETH), 18 decimals |

**When to use:** value a cbETH position in ETH terms, track staking yield over time, gate a workflow on the rate moving past a threshold, compare cbETH against another liquid staking token.

---

## Get cbETH Balance

Check the cbETH balance of an address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Address whose cbETH balance will be read |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | cbETH Balance (wei), 18 decimals |

**When to use:** monitor a treasury or user position, trigger on a balance threshold, combine with the exchange rate to compute the ETH value of a holding.

---

## Get cbETH Total Supply

Get the total supply of cbETH in circulation.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint256 | Total cbETH Supply (wei), 18 decimals |

**When to use:** track adoption of cbETH over time, alert on a large supply change.

---

## Why no testnet entry in the plugin

Coinbase publishes cbETH on Ethereum mainnet only. Sepolia, Holesky and Goerli were checked and carry no cbETH deployment, so a testnet chain ID here would need a fabricated address that reverts on the first call.

Base is also absent, for a different reason. The cbETH on Base is an OP-stack bridged representation rather than a second deployment: its `l1Token()` points back at the mainnet address above, while `exchangeRate()` reverts there. `balanceOf` plus `totalSupply` do work on Base, so it can be added later, but because the plugin derives one action set per contract entry that has to be a separate contract key rather than an extra address on this one. Shipping it as an extra address would advertise an exchange-rate read that fails on L2.

To exercise the reads without touching mainnet, fork it locally with Anvil:

```bash
docker run --rm -p 8545:8545 ghcr.io/foundry-rs/foundry:v1.7.1 \
  "anvil --host 0.0.0.0 --fork-url <YOUR_MAINNET_RPC_URL>"
```

Then point the dev server at the fork:

```bash
CHAIN_ETH_MAINNET_PRIMARY_RPC=http://localhost:8545 pnpm dev
```

Any workflow targeting chain ID 1 will read the forked bytecode.
