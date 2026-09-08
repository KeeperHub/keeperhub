---
title: "Frax Ether V2"
description: "Liquid staking on Ethereum mainnet. Deposit native ETH to mint frxETH (1:1 receipt) or sfrxETH (yield-bearing ERC4626 vault) in one transaction."
---

# Frax Ether V2

Frax Ether V2 is the second-generation liquid staking system from Frax Finance. Users deposit native ETH and receive either frxETH (a 1:1 ETH receipt token) or sfrxETH (an ERC4626 vault share that accrues staking yield over time). The yield comes from validators operated by the Frax protocol; staking rewards accrue to sfrxETH holders.

Supported chains: Ethereum Mainnet only. The V2 minter contract lives at `0x7Bc6bad540453360F744666D625fec0ee1320cA3`. The frxETH and sfrxETH token addresses are unchanged from V1; only the minter and redemption queue are V2-specific. Read-only actions work without credentials. Write actions require a connected wallet and native ETH value.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Mint frxETH | Write | Wallet | Deposit native ETH and mint frxETH 1:1 to the sending address |
| Mint frxETH to Recipient | Write | Wallet | Deposit native ETH and mint frxETH 1:1 to a different recipient |
| Mint and Stake into sfrxETH | Write | Wallet | Mint frxETH and immediately stake it in sfrxETH in one transaction |
| Check Mint Pause Status | Read | No | Read whether minting is currently paused on the V2 minter |

---

## Mint frxETH

Deposit native ETH and mint frxETH 1:1 to the sending address.

**Inputs:** None (the native ETH value sent with the transaction IS the input)

**Outputs:** none (minted frxETH is delivered to msg.sender)

**When to use:** workflows that need to convert native ETH into a liquid staking receipt token without immediately staking it. The frxETH can later be staked into sfrxETH, swapped on a DEX, used as collateral, or transferred.

---

## Mint frxETH to Recipient

Deposit native ETH from the sender and mint frxETH 1:1 to a separate recipient address. Useful for treasury operations where the funding account differs from the holding account.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| recipient | address | Address that will receive the minted frxETH |

**Outputs:** none (minted frxETH is delivered to the recipient address)

**When to use:** funding a multisig or sub-account with frxETH from an operational wallet, distributing frxETH to a beneficiary, or routing minted frxETH directly to a yield strategy contract.

---

## Mint and Stake into sfrxETH

Mint frxETH and immediately deposit it into the sfrxETH ERC4626 vault in a single transaction. Returns the amount of sfrxETH shares received.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| recipient | address | Address that will receive the minted sfrxETH shares |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| shares | uint256 | sfrxETH Shares Received (wei), 18 decimals |

**When to use:** the most gas-efficient way to go from native ETH to yield-bearing sfrxETH. Skips the intermediate frxETH transfer and the separate vault deposit transaction.

---

## Check Mint Pause Status

Read whether minting is currently paused on the Frax Ether V2 minter.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| paused | bool | True if minting is paused, false if mints are accepted |

**When to use:** as a gate in scheduled workflows so a mint action only runs when the contract is unpaused. Useful for resilient automation that should self-suspend during contract maintenance windows.

---

## Testing Without Risking Real ETH

Frax Ether V2 has no testnet deployment. The V2 minter contract lives only on Ethereum mainnet, so the only way to exercise the write path (mintFrxEth, mintFrxEthAndGive, submitAndDeposit) end-to-end without spending real ETH is against a local mainnet fork.

### One-shot smoke test

A scripted smoke test broadcasts a real `mintFrxEth` against forked mainnet bytecode and asserts the 1:1 frxETH mint. Recommended whenever upgrading the plugin, the ABI, or the dispatching layer.

In one terminal, start anvil with your mainnet RPC:

```bash
docker run --rm -p 8545:8545 ghcr.io/foundry-rs/foundry:v1.7.1 \
  "anvil --host 0.0.0.0 --fork-url <YOUR_MAINNET_RPC_URL>"
```

Pin an explicit version rather than using `latest` or `stable`. On GHCR, `latest`
is foundry's nightly build, which changes daily and has shipped versions of anvil
that cannot fork some chains at all; `stable` is unmaintained and lags well behind
the newest release.

In another terminal, run the smoke test:

```bash
pnpm tsx scripts/frax-ether-v2-fork-test.ts
```

The script uses one of anvil's pre-funded test accounts, mints 1 frxETH, and prints a PASS line on success.

### Driving the UI against the fork

For end-to-end UI testing, point your local dev server at the same fork by overriding the Ethereum mainnet RPC URL:

```bash
CHAIN_ETH_MAINNET_PRIMARY_RPC=http://localhost:8545 pnpm dev
```

Any wallet you connect must be funded on the fork (use one of anvil's pre-funded private keys, or `anvil_setBalance` via `cast`). Workflows that target chain ID 1 will then hit the forked bytecode instead of real mainnet.

### Why no testnet entry in the plugin

Adding a Sepolia or Holesky chain ID to the plugin would require a contract address. Frax did not deploy the V2 minter on any public testnet (verified against the official frxETH V2 addresses page and Sepolia and Holesky block explorers), so any address added would be fabricated and would revert on first call. The fork pattern above is the supported substitute.
