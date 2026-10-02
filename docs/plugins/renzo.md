---
title: "Renzo"
description: "Liquid restaking on Ethereum. Deposit native ETH to mint ezETH, a non-rebasing restaked-ETH token earning staking plus EigenLayer restaking rewards."
---

# Renzo

Renzo is a liquid restaking protocol on Ethereum. Users deposit native ETH into the Renzo Restake Manager and receive ezETH, a non-rebasing token that tracks the deposit plus staking and EigenLayer restaking rewards. The ezETH/ETH exchange rate increases over time as rewards accrue.

Supported chains: Ethereum Mainnet only. The Restake Manager lives at `0x74a09653A083691711cF8215a6ab074BB4e99ef5`, ezETH at `0xbf5495Efe5DB9ce00f80364C8B423567e58d2110` and the risk-oracle middleware at `0x08921F17A32110F8df44A3d5007F2acd09Cfae6d`. Read-only actions work without credentials. The write action requires a connected wallet and native ETH value.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Stake ETH for ezETH | Write | Wallet | Deposit native ETH into the Restake Manager and mint ezETH to the sending address |
| Check Manager Pause Flag | Read | No | Read the Restake Manager's own pause flag, one of the two deposit-pause conditions |
| Check Risk Oracle Deposit Pause | Read | No | Read whether the risk-oracle middleware has deposits paused, the other condition |
| Get ezETH Balance | Read | No | Check the ezETH balance of an address |
| Get ezETH Total Supply | Read | No | Get total ezETH tokens in circulation |

---

## Stake ETH for ezETH

Deposit native ETH into the Renzo Restake Manager and mint ezETH to the sending address. The manager returns ezETH tracking the deposit plus staking and restaking rewards.

**Inputs:** None (the native ETH value sent with the transaction is the input)

**Outputs:** none (minted ezETH is delivered to msg.sender)

**Unbounded write.** `depositETH()` takes no arguments, so this action cannot carry a minimum-received bound: the amount of ezETH minted is whatever Renzo's oracle prices the deposit at in the block the transaction lands in, and there is no user-supplied floor to reject a worse rate. That is the shape of the contract, not a default this plugin chose. The native value you send is the only quantity under your control, and it is still charged against your organization's daily native-value cap.

**When to use:** workflows that need to convert native ETH into a liquid restaking receipt token. The ezETH can later be swapped on a DEX, used as collateral, or transferred.

---

## The deposit pause gate is two reads

The Restake Manager guards `depositETH()` with a modifier that checks two independent sources:

```solidity
if (paused || riskOracleMiddleware.depositPaused()) revert ContractPaused();
```

The manager's own `paused` flag is one source. Renzo's risk-oracle middleware is the other, and it can halt deposits while `paused` stays false. Neither read on its own answers "are deposits accepted" - a workflow that needs that answer has to read both and proceed only when both are false.

A stake attempted while either source is set fails during the pre-broadcast simulation, before a nonce is allocated, so it costs no gas and produces no transaction. Gating on both reads is about not scheduling work that cannot succeed, not about protecting funds.

---

## Check Manager Pause Flag

Read the Restake Manager's own pause flag.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| paused | bool | True if the manager's own pause flag is set. False means this condition is clear; it does not on its own mean deposits are accepted |

**When to use:** together with Check Risk Oracle Deposit Pause, as a gate in scheduled workflows so a stake action only runs when both conditions are clear. Useful for resilient automation that should self-suspend during contract maintenance windows.

---

## Check Risk Oracle Deposit Pause

Read whether Renzo's risk-oracle middleware has deposits paused.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| depositPaused | bool | True if the middleware has deposits paused. False means this condition is clear; it does not on its own mean deposits are accepted |

**When to use:** together with Check Manager Pause Flag, as the second half of a deposit gate. The Restake Manager reads this same middleware on every deposit, so a workflow that skips it can decide deposits are open while the protocol is rejecting them.

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

Renzo publishes no testnet deployment of the Restake Manager or ezETH in its contract-addresses documentation, and the chains that were checked directly are empty. `eth_getCode` returned `0x` for all three addresses on Sepolia (block 11749545), Hoodi (3666291), Base (51593591), Arbitrum One (507373261), Base Sepolia (47104121) and Arbitrum Sepolia (311144498), read on 2026-09-21.

Two chains were not checked rather than confirmed clean: Holesky and Goerli. Every public endpoint tried for them refused the request - Holesky answered 404 on `ethereum-holesky-rpc.publicnode.com` and 400 on `holesky.drpc.org` and `1rpc.io/holesky`, Goerli answered 404 on `ethereum-goerli-rpc.publicnode.com` and `goerli.drpc.org` - so neither is claimed here either way. Adding a testnet chain ID on the strength of an unchecked chain would mean shipping an address that reverts on first call.

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
