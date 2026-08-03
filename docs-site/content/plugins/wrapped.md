---
title: "Wrapped"
description: "Wrap a chain's native token into its wrapped ERC-20 form (WETH, WBNB, WMATIC, WAVAX) and unwrap back."
---

# Wrapped

Many DeFi protocols require an ERC-20 token rather than a chain's native asset. This plugin wraps a chain's native token (ETH, BNB, MATIC, or AVAX depending on the chain) into its 1:1 wrapped ERC-20 form, and unwraps it back to the native token. The contract used is whichever wrapped-native token is canonical for the selected chain, for example WETH on Ethereum, Base, and Arbitrum.

Supported chains: Ethereum, Base, Arbitrum, and Sepolia (WETH), plus Base Sepolia and Arbitrum Sepolia testnets. The underlying integration also covers BNB Smart Chain and BNB Testnet (WBNB), Polygon (WMATIC), and Avalanche C-Chain and Fuji testnet (WAVAX); the chain selector restricts to whichever of these are configured for your workflow. Read-only actions work without credentials. Write actions require a connected wallet.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Wrap Native Token | Write | Wallet | Wrap the chain's native token into its wrapped ERC-20 form |
| Unwrap Wrapped Token | Write | Wallet | Unwrap the wrapped token back to the chain's native token |
| Check Wrapped Token Balance | Read | No | Read the wrapped token balance of an address on the selected chain |

---

## Wrap Native Token

Wrap the chain's native token into its wrapped ERC-20 form. Send native token value with the transaction; the contract mints an equal amount (1:1) of the wrapped token to the sender.

**Inputs:** Native token amount is sent as the transaction's ETH value (no separate amount input).

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Prepare native token for use in DeFi protocols that only accept ERC-20 tokens, fund a SuperToken wrap, provision liquidity that expects a wrapped-token deposit.

---

## Unwrap Wrapped Token

Unwrap the wrapped token back to the chain's native token. The contract burns the specified amount of wrapped token and sends an equal amount of native token to the sender.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| wad | uint256 | Amount (wei) of wrapped token to burn; an equal amount of native token is sent back to your address |

**Outputs:** `success`, `transactionHash`, `transactionLink`, `error`

**When to use:** Convert wrapped-token balances back to native token for gas, exit a position that ends in the wrapped token, consolidate holdings into native token.

---

## Check Wrapped Token Balance

Read the wrapped token balance of an address on the selected chain.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| account | address | Wallet Address |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| balance | uint256 | Wrapped Token Balance (wei), 18 decimals |

**When to use:** Verify a wrap or unwrap succeeded, monitor wrapped-token holdings before running a downstream DeFi action.

---

## Example Workflows

### Wrap Then Supply

`Manual -> Wrapped: Wrap Native Token -> Wrapped: Check Wrapped Token Balance -> Aave V3: Supply Asset`

Wrap native ETH into WETH, confirm the balance credited, then supply it into a lending protocol that requires an ERC-20.

### Unwrap on Withdrawal

`Aave V3: Withdraw Asset -> Wrapped: Unwrap Wrapped Token -> Discord: Send Message`

After withdrawing a wrapped-token position from a lending protocol, unwrap it back to native token and notify your team.

---

## Supported Chains

| Chain | Wrapped Token |
|-------|---------------|
| Ethereum (1) | WETH |
| Base (8453) | WETH |
| Arbitrum (42161) | WETH |
| Sepolia (11155111) | WETH |
| Base Sepolia (84532) | WETH |
| Arbitrum Sepolia (421614) | WETH |
| BNB Smart Chain (56) | WBNB |
| BNB Testnet (97) | WBNB |
| Polygon (137) | WMATIC |
| Avalanche C-Chain (43114) | WAVAX |
| Avalanche Fuji (43113) | WAVAX |

Optimism is not currently included in this protocol's chain list.
