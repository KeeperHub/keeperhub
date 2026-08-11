---
title: "CoW Swap"
description: "CoW Protocol actions for MEV-protected batch auction trading, order pre-signing, and conditional orders."
---

# CoW Swap

CoW Protocol is a decentralized exchange protocol that uses batch auctions to provide MEV protection for traders. Orders are collected off-chain and settled on-chain by solvers competing for the best execution price. The protocol supports pre-signing for smart contract wallets and conditional (programmatic) orders via ComposableCoW.

**Supported chains**: Ethereum, Base, Arbitrum One, Optimism

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Get Domain Separator | Read | None | EIP-712 domain separator for order digest computation |
| Get Vault Relayer | Read | None | Address users must approve sell tokens to |
| Get Order Fill Amount | Read | None | How much of an order has been filled |
| Get Pre-Signature Status | Read | None | Whether an order has been pre-signed |
| Set Pre-Signature | Write | Wallet | Pre-sign an order on-chain |
| Invalidate Order | Write | Wallet | Permanently cancel an order |
| Check Conditional Order | Read | None | Whether a conditional order is registered |
| Get Cabinet Value | Read | None | Read conditional order handler state |
| Remove Conditional Order | Write | Wallet | Remove a conditional order |
| Create Conditional Order | Write | Wallet | Create a TWAP or stop-loss conditional order on ComposableCoW |
| Get Quote | API | None | Get a price quote from the CoW Swap orderbook |
| Get Order Status | API | None | Check the status of an order by UID |
| Create Order | API | None | Submit a pre-built signed order to the orderbook |
| Cancel Order | API | None | Cancel a pending order before it is filled |
| Get Account Orders | API | None | List all orders for a wallet address |
| Get Trades | API | None | Get executed trades for a wallet address |

## Get Domain Separator

Returns the EIP-712 domain separator used to compute order digests for this deployment. Useful for constructing order UIDs off-chain.

**Inputs**: None

**Outputs**:
- `domainSeparator` (bytes32) -- The EIP-712 domain separator

**When to use**: Before computing an order digest for pre-signing or verification.

## Get Vault Relayer

Returns the GPv2VaultRelayer contract address. Users must approve their sell tokens to this address (not the settlement contract) before placing orders.

**Inputs**: None

**Outputs**:
- `vaultRelayer` (address) -- The GPv2VaultRelayer contract address

**When to use**: Before setting up token approvals for CoW Swap trading.

## Get Order Fill Amount

Returns how much of an order has been filled so far, in sell token units. Returns 0 for unfilled or unknown orders.

**Inputs**:
- `orderUid` (bytes) -- The 56-byte unique order identifier

**Outputs**:
- `filledAmount` (uint256) -- Amount filled in sell token units

**When to use**: To monitor order execution progress or verify partial fills.

## Get Pre-Signature Status

Returns the pre-signature status for an order. A non-zero value means the order has been pre-signed and is valid for solver execution.

**Inputs**:
- `orderUid` (bytes) -- The 56-byte unique order identifier

**Outputs**:
- `preSignature` (uint256) -- Non-zero if order is pre-signed

**When to use**: To verify that a smart contract wallet's order is ready for execution.

## Set Pre-Signature

Pre-signs an order on-chain, enabling solver execution without an off-chain ECDSA signature. Required for smart contract wallets (e.g., Safe multisigs) that cannot produce ECDSA signatures. Set `signed` to false to cancel a pre-signed order.

**Inputs**:
- `orderUid` (bytes) -- The 56-byte unique order identifier
- `signed` (bool) -- True to enable, false to cancel

**When to use**: When a Safe or other smart contract wallet needs to place a CoW Swap order.

## Invalidate Order

Permanently cancels an order on-chain by marking it as fully filled. Once invalidated, the order cannot be executed even if it was previously valid or pre-signed.

**Inputs**:
- `orderUid` (bytes) -- The 56-byte unique order identifier

**When to use**: To permanently cancel an order that should never be filled.

## Check Conditional Order

Returns whether a specific conditional order (TWAP, stop-loss, etc.) has been registered by an owner in ComposableCoW.

**Inputs**:
- `owner` (address) -- The owner address
- `orderHash` (bytes32) -- The keccak256 hash of the ConditionalOrderParams

**Outputs**:
- `exists` (bool) -- True if the order is registered

**When to use**: To verify that a conditional order is active before relying on it.

## Get Cabinet Value

Reads conditional order-specific state stored by the order handler. The cabinet is a key-value store scoped to each owner, used by order types (TWAP, stop-loss) to persist state between executions.

**Inputs**:
- `owner` (address) -- The owner address
- `key` (bytes32) -- The storage key (typically the conditional order hash)

**Outputs**:
- `value` (bytes32) -- The stored value

**When to use**: To inspect internal state of a running conditional order.

## Remove Conditional Order

Removes a previously created conditional order from ComposableCoW, preventing it from being executed in future batches.

**Inputs**:
- `singleOrderHash` (bytes32) -- The keccak256 hash of the ConditionalOrderParams

**When to use**: To cancel a TWAP, stop-loss, or other conditional order.

## Example Workflows

### Safe Multisig Order Execution

Pre-sign a CoW Swap order from a Safe multisig, then monitor fill progress:

1. **CoW Swap: Set Pre-Signature** -- Pre-sign the order UID on-chain from the Safe
2. **CoW Swap: Get Pre-Signature Status** -- Verify the pre-signature was recorded
3. **CoW Swap: Get Order Fill Amount** -- Poll fill status until complete
4. **Condition** -- Check if `filledAmount > 0`
5. **Discord: Send Message** -- Notify team of order execution

### Order Monitoring and Cancellation

Monitor an active order and cancel it if conditions change:

1. **Schedule Trigger** -- Run every 5 minutes
2. **CoW Swap: Get Order Fill Amount** -- Check current fill status
3. **Condition** -- If order is still unfilled after deadline
4. **CoW Swap: Invalidate Order** -- Cancel the stale order
5. **Telegram: Send Message** -- Alert that order was cancelled

### Conditional Order Lifecycle

Manage a TWAP order lifecycle through ComposableCoW:

1. **CoW Swap: Check Conditional Order** -- Verify order is active
2. **CoW Swap: Get Cabinet Value** -- Read TWAP execution progress
3. **Condition** -- Check if TWAP is complete or stalled
4. **CoW Swap: Remove Conditional Order** -- Clean up completed order
5. **SendGrid: Send Email** -- Send execution summary

## Supported Chains

| Chain | Chain ID | Settlement | ComposableCoW |
|-------|----------|------------|---------------|
| Ethereum | 1 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74` |
| Base | 8453 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74` |
| Arbitrum One | 42161 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74` |
| Optimism | 10 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74` |

All contracts use deterministic CREATE2 deployment and share the same address across all supported chains.
