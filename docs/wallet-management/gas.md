---
title: "Gas Management"
description: "Understanding gas limit estimation and configuration for blockchain transactions in KeeperHub."
---

# Gas Management

KeeperHub handles gas configuration automatically for all blockchain transactions. This page explains how gas limits are calculated and how to override the defaults when needed.

## How Gas Limit Estimation Works

Every transaction goes through three stages:

1. **Estimate** - KeeperHub calls `eth_estimateGas` on the network to get the minimum gas units required
2. **Multiply** - The estimate is multiplied by a safety factor (the gas limit multiplier) to account for on-chain state changes between estimation and execution
3. **Submit** - The final gas limit is set on the transaction

```
Final Gas Limit = Estimated Gas x Multiplier
```

The multiplier exists because gas estimates are point-in-time snapshots. Between estimation and on-chain execution, contract state can change (other transactions may execute first), which can increase the actual gas required. Without a buffer, transactions risk running out of gas and reverting -- wasting the gas fee while accomplishing nothing.

## Default Multipliers

Defaults vary by chain type. L2 networks use lower multipliers because their gas estimates tend to be more accurate.

| Chain | Standard Multiplier | Conservative Multiplier |
|-------|-------------------|----------------------|
| Ethereum | 2.0x | 2.5x |
| Polygon | 2.0x | 2.5x |
| Arbitrum | 1.5x | 2.0x |
| Base | 1.5x | 2.0x |

**Standard** multiplier is used for manual triggers and scheduled workflows.

**Conservative** multiplier is used for time-sensitive triggers (event-based, webhook) where retry opportunity is limited and failing the transaction is more costly.

These defaults are resolved in order: database chain config > hardcoded chain overrides > global default (2.0x / 2.5x).

## Gas Limit Override

You can set an absolute gas limit per action node:

1. Open the action node configuration (Transfer Native Token, Transfer ERC20 Token, Approve ERC20 Token, or Write Contract)
2. Expand the **Advanced** section
3. Set the **Gas Limit** field to an absolute gas unit value (e.g. 500000)

### Field Behavior

- **When empty**: The default 2.0x multiplier is applied to the gas estimate at execution time
- **When set**: Your absolute value is used directly as the transaction gas limit, bypassing the multiplier

The field also shows a live gas estimate when enough configuration is filled in (network, contract address, function, etc.). This helps you choose an appropriate gas limit. If your value is below the current estimate, a warning is shown.

### Example

If the network estimates 100,000 gas for your transaction:

| Gas Limit Setting | Result |
|-------------------|--------|
| Empty (default) | 200,000 (estimate x 2.0) |
| 150,000 | 150,000 (used directly) |
| 500,000 | 500,000 (used directly) |

Setting a gas limit below the estimate will cause the transaction to revert with an out-of-gas error. Setting it close to the estimate risks failure if on-chain state changes between estimation and execution.

## Gas Sponsorship

On supported networks, KeeperHub can sponsor the **gas fee** of a workflow transaction through Turnkey's Gas Station, so a workflow can run even when the sending wallet holds no native gas token. Sponsorship is enabled per organization and metered against a monthly gas credit allowance shown on your billing page.

Sponsorship also changes how the transaction appears on a block explorer. See [What Your Transaction Looks Like On-Chain](/wallet-management/onchain-appearance).

### What sponsorship covers

Sponsorship pays the **transaction fee only**. It does not provide the assets your transaction moves. The native value a transaction sends (for example, the ETH amount in a Transfer Native Token action) is always debited from your own wallet.

To send 0.1 ETH to another address, your wallet must hold at least 0.1 ETH; sponsorship only means it does not also need extra ETH to cover the gas fee. A token transfer (USDC and similar) likewise requires the token balance in your wallet. Only the gas is sponsored.

### When a transaction is sponsored

A transaction is sponsored only when all of the following are true. Otherwise it falls back to paying gas from your wallet, and it fails if that wallet has no native balance.

- **Supported network**: Ethereum, Base, Polygon, and Arbitrum, plus their testnets (Sepolia, Base Sepolia, Polygon Amoy, Arbitrum Sepolia).
- **Direct wallet sender (no Safe)**: the active Sender is the wallet itself.
- **Public mempool**: transactions routed through a private mempool are not sponsored.
- **Gas credits available**: your organization still has gas credits for the current period.

### Safe wallets

Workflows that route through a Safe (Sender ON) are not gas sponsored. The sponsored transaction is built as a direct call from your wallet, so applying it to a Safe write would change `msg.sender` away from the Safe. Safe writes pay gas from the wallet that signs the outer transaction; direct wallet sends remain eligible for sponsorship.

### Gas credits

Sponsored gas is metered in USD against your plan's monthly gas credit cap (shown on the billing page). Mainnet usage counts against the cap; testnet usage is not charged. When the cap is reached, sponsorship pauses for the rest of the period and transactions pay gas from the wallet.

## FAQ

### What happens if I leave the gas limit empty?

The default 2.0x multiplier is applied to the gas estimate at execution time. For time-sensitive triggers (event-based, webhook), a 2.5x conservative multiplier is used instead.

### What happens if my gas limit is too low?

The transaction will revert with an "out of gas" error. You will still pay for the gas consumed up to the limit. KeeperHub's retry logic may re-attempt with the default multiplier.

### What happens if my gas limit is too high?

The transaction reserves more gas but only consumes what it needs. Unused gas is refunded. There is no direct cost penalty, but very high limits may cause the transaction to be deprioritized by some networks.

### Does the gas limit affect gas price/fees?

No. The gas limit only sets the maximum gas units. Gas pricing (base fee, priority fee) is handled separately by KeeperHub's adaptive fee strategy and is not configurable through this field.

## Solana Fees

Solana transactions do not use EVM-style gas limits or multipliers. Instead, fees are paid in lamports from your SOL balance.

Every confirmed transaction includes a **base signature fee** of 5,000 lamports. If the transaction sets a compute-unit price, KeeperHub also reports the priority component derived from consumed compute units and the effective micro-lamport price.

In workflow outputs for Solana transfers:

- `gasUsed` is the total lamport fee paid
- `gasUsedUnits` is the compute units consumed
- `effectiveGasPrice` is the micro-lamports-per-compute-unit price used for the priority component

There is no gas limit multiplier on Solana write actions. Ensure the wallet holds enough SOL to cover both the transfer amount (for native SOL sends) and the transaction fee, plus any rent required when creating a recipient associated token account during SPL transfers.

## Wallet Funding

Ensure your Turnkey wallet has sufficient ETH to cover:

- Transaction gas costs
- Retry attempts
- Potential gas price spikes during network congestion

See [Turnkey Integration](/wallet-management/turnkey) for wallet funding details.
