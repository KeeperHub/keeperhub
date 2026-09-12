---
title: "ether.fi"
description: "Liquid restaking on Ethereum. Deposit ETH to mint eETH, wrap into weETH, read pool accounting plus exchange rates."
---

# ether.fi

ether.fi is a liquid restaking protocol on Ethereum. Depositing ETH into the Liquidity Pool mints eETH, a rebasing receipt token whose balance grows as staking plus EigenLayer restaking rewards accrue. eETH wraps into weETH, a non-rebasing ERC20 whose balance is fixed while its exchange rate against eETH climbs. weETH is the form used across most DeFi integrations because a fixed balance is easier for other contracts to account for.

Supported chains: Ethereum Mainnet only. Minting settles on the beacon chain, so the deposit path exists on mainnet alone. The L2 weETH representations are LayerZero-bridged rather than mintable here. Read-only actions need no credentials. Write actions require a connected wallet.

Contracts: Liquidity Pool `0x308861A430be4cce5502d0A12724771Fc6DaF216`, eETH `0x35fA164735182de50811E8e2E824cFb9B6118ac2`, weETH `0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee`.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Stake ETH for eETH | Write | Wallet | Deposit native ETH into the Liquidity Pool and mint eETH |
| Wrap eETH into weETH | Write | Wallet | Wrap rebasing eETH into non-rebasing weETH |
| Unwrap weETH into eETH | Write | Wallet | Unwrap weETH back into eETH at the current rate |
| Get Total Pooled ETH | Read | No | Total ETH the pool accounts for across all stakers |
| Convert eETH Shares to ETH | Read | No | Price a number of eETH shares in ETH |
| Convert ETH to eETH Shares | Read | No | Convert an ETH amount into eETH shares |
| Get weETH Rate | Read | No | Current eETH value of one weETH |
| Convert eETH to weETH | Read | No | Preview a wrap at the current rate |
| Convert weETH to eETH | Read | No | Preview an unwrap at the current rate |
| Get eETH Balance | Read | No | eETH balance of an address |
| Get eETH Total Shares | Read | No | Total eETH shares outstanding |
| Get weETH Balance | Read | No | weETH balance of an address |
| Get weETH Total Supply | Read | No | Total weETH in circulation |

---

## Stake ETH for eETH

Deposit native ETH into the ether.fi Liquidity Pool and mint eETH to the sending address.

**Inputs:** None (the native ETH value sent with the transaction is the input)

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| shares | uint256 | eETH shares minted, 18 decimals |

**When to use:** the entry point for putting ETH to work in restaking from a workflow. Pair it with the balance read to confirm the mint landed.

---

## Wrap eETH into weETH

Wrap rebasing eETH into non-rebasing weETH. The weETH contract must be approved to spend at least the wrapped amount of eETH first.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| amount | uint256 | eETH to wrap (wei), 18 decimals |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| weETHReceived | uint256 | weETH received (wei), 18 decimals |

**When to use:** before sending restaked ETH into a protocol that cannot handle a rebasing balance. Also for holding a position whose token count stays constant.

---

## Unwrap weETH into eETH

Unwrap non-rebasing weETH back into rebasing eETH at the current rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| amount | uint256 | weETH to unwrap (wei), 18 decimals |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| eETHReceived | uint256 | eETH received (wei), 18 decimals |

**When to use:** returning to the rebasing form, usually as a step before entering the withdrawal queue.

---

## Get Total Pooled ETH

Read the total ETH the Liquidity Pool accounts for across all stakers.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalPooledEther | uint256 | Total pooled ETH (wei), 18 decimals |

**When to use:** a TVL and health signal. Gate a deposit workflow on the pool being of an expected size. Alert on a sharp move.

---

## Convert eETH Shares to ETH

Read how much ETH a given number of eETH shares is worth at the current pool exchange rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| shares | uint256 | eETH shares to price (wei), 18 decimals |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| ethAmount | uint256 | ETH value (wei), 18 decimals |

**When to use:** valuing a share-denominated position in ETH terms, which is what a rebasing balance hides.

---

## Convert ETH to eETH Shares

Read how many eETH shares a given amount of ETH would mint at the current pool exchange rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| ethAmount | uint256 | ETH amount to convert (wei), 18 decimals |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| shares | uint256 | eETH shares (wei), 18 decimals |

**When to use:** sizing a deposit before sending it. Also reconciling an expected mint against the shares actually credited.

---

## Get weETH Rate

Read the current eETH value of one weETH. The rate only ratchets up as staking plus restaking rewards accrue.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| rate | uint256 | Rate (wei of eETH per weETH), 18 decimals |

**When to use:** track restaking yield. Trigger on the rate crossing a threshold. This is the same number the pool reports as its share price.

---

## Convert eETH to weETH

Read how much weETH a given amount of eETH would wrap into at the current rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| amount | uint256 | eETH amount to price (wei), 18 decimals |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| weETHAmount | uint256 | weETH amount (wei), 18 decimals |

**When to use:** previewing a wrap so a workflow can decide before spending gas.

---

## Convert weETH to eETH

Read how much eETH a given amount of weETH is worth at the current rate.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| amount | uint256 | weETH amount to price (wei), 18 decimals |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| eETHAmount | uint256 | eETH amount (wei), 18 decimals |

**When to use:** valuing a weETH holding in eETH or ETH terms without unwrapping it.

---

## Get eETH Balance

Check the eETH balance of an address. eETH is rebasing, so this value grows as rewards accrue with no transfer.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Address whose eETH balance will be read |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | eETH balance (wei), 18 decimals |

**When to use:** confirming a stake credited. Also monitoring a position as it rebases.

---

## Get eETH Total Shares

Get the total eETH shares outstanding. Shares are the non-rebasing accounting unit behind eETH balances.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalShares | uint256 | Total eETH shares (wei), 18 decimals |

**When to use:** paired with total pooled ETH, this gives the pool's share price directly, which is useful for auditing the rate the wrapper reports.

---

## Get weETH Balance

Check the weETH balance of an address.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Address whose weETH balance will be read |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | weETH balance (wei), 18 decimals |

**When to use:** monitoring a wrapped position. Unlike the eETH balance this only moves on a transfer, wrap or unwrap.

---

## Get weETH Total Supply

Get the total supply of weETH in circulation.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| totalSupply | uint256 | Total weETH supply (wei), 18 decimals |

**When to use:** tracking how much of the protocol sits in wrapped form. Alerting on a large supply change.

---

## Not covered here

Unstaking is a withdrawal queue rather than an instant unwrap: a request mints an NFT that is claimed once the exit completes. That is a separate surface with its own contract and lifecycle, so it is not part of this plugin.

## Why no testnet entry in the plugin

ether.fi runs the Liquidity Pool, eETH and weETH on Ethereum mainnet only. Sepolia, Holesky and Goerli were checked and carry no ether.fi deployment, so any testnet chain ID added here would need a fabricated address that reverts on the first call. Minting is inherently mainnet-bound anyway because staking settles on the beacon chain.

The L2 weETH tokens on Arbitrum, Base and Optimism are LayerZero OFT representations, not mintable from this Liquidity Pool, so they are not a second address on these contract entries either.

To exercise the write path without spending real ETH, fork mainnet locally with Anvil:

```bash
docker run --rm -p 8545:8545 ghcr.io/foundry-rs/foundry:v1.7.1 \
  "anvil --host 0.0.0.0 --fork-url <YOUR_MAINNET_RPC_URL>"
```

Pin an explicit version rather than `latest` or `stable`. Then point the dev server at the fork:

```bash
CHAIN_ETH_MAINNET_PRIMARY_RPC=http://localhost:8545 pnpm dev
```

Any wallet you connect must be funded on the fork (use one of Anvil's pre-funded keys, alternatively `anvil_setBalance` via `cast`). Workflows targeting chain ID 1 then hit the forked bytecode.
