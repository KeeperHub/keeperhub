---
title: "Renzo"
description: "Liquid restaking on Ethereum. Deposit native ETH to mint ezETH, a non-rebasing restaked-ETH token earning staking plus EigenLayer restaking rewards."
---

# Renzo

Renzo is a liquid restaking protocol on Ethereum. Users deposit native ETH into the Renzo Restake Manager and receive ezETH, a non-rebasing token that tracks the deposit plus staking and EigenLayer restaking rewards. The ezETH/ETH exchange rate increases over time as rewards accrue.

Supported chains: Ethereum Mainnet only. The Restake Manager lives at `0x74a09653A083691711cF8215a6ab074BB4e99ef5` and ezETH at `0xbf5495Efe5DB9ce00f80364C8B423567e58d2110`. Read-only actions work without credentials. The write action requires a connected wallet and native ETH value.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Stake ETH for ezETH | Write | Wallet | Deposit native ETH into the Restake Manager and mint ezETH to the sending address |
| Check Deposit Pause Status | Read | No | Read whether the Restake Manager is paused |
| Get ezETH Balance | Read | No | Check the ezETH balance of an address |
| Get ezETH Total Supply | Read | No | Get total ezETH tokens in circulation |

---

## Stake ETH for ezETH

Deposit native ETH into the Renzo Restake Manager and mint ezETH to the sending address. The manager returns ezETH tracking the deposit plus staking and restaking rewards.

**Inputs:** None (the native ETH value sent with the transaction is the input)

**Outputs:** none (minted ezETH is delivered to msg.sender)

**When to use:** workflows that need to convert native ETH into a liquid restaking receipt token. The ezETH can later be swapped on a DEX, used as collateral, or transferred.

---

## Check Deposit Pause Status

Read whether the Renzo Restake Manager is currently paused. Deposits revert while the manager is paused.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| paused | bool | True if deposits are paused, false if deposits are accepted |

**When to use:** as a gate in scheduled workflows so a stake action only runs when the contract is unpaused. Useful for resilient automation that should self-suspend during contract maintenance windows.

---

## Get ezETH Balance

Check the ezETH balance of an address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Address whose ezETH balance will be read |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | ezETH Balance (wei), 18 decimals |

**When to use:** monitor restaking positions, trigger actions based on balance thresholds, track ezETH holdings across addresses.

---

## Get ezETH Total Supply

Get the total supply of ezETH in circulation.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint256 | Total ezETH Supply (wei), 18 decimals |

**When to use:** monitor protocol TVL growth, compare restaking adoption across protocols, trigger alerts on supply changes.

---

## Why no testnet entry in the plugin

Renzo did not deploy the Restake Manager or ezETH on any public testnet. Verified against the official Renzo contract addresses documentation and Sepolia, Holesky and Goerli block explorers: no matching bytecode or verified contract exists. Adding a testnet chain ID would require a fabricated address that reverts on first call.

To exercise the write path without spending real ETH, fork Ethereum mainnet locally with Anvil:

```bash
docker run --rm -p 8545:8545 ghcr.io/foundry-rs/foundry:v1.7.1 \
  "anvil --host 0.0.0.0 --fork-url <YOUR_MAINNET_RPC_URL>"
```

Then point the dev server at the fork:

```bash
CHAIN_ETH_MAINNET_PRIMARY_RPC=http://localhost:8545 pnpm dev
```

Connect a wallet funded on the fork (use one of Anvil's pre-funded private keys or `anvil_setBalance` via `cast`) and any workflow targeting chain ID 1 will hit the forked bytecode.
