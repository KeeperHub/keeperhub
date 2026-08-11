---
title: "Tempo Plugin"
description: "Accept stablecoin payments on Tempo, reconcile them by on-chain memo, pay out in atomic batches, and swap on the native DEX, signed by your KeeperHub wallet."
---

# Tempo Plugin

[Tempo](https://tempo.xyz) is a stablecoin-native EVM chain. Payments carry a protocol-level 32-byte memo, fees are paid in stablecoins (there is no separate gas token), and settlement is fast. This plugin lets a workflow send stablecoin payments with an on-chain memo, pay many recipients in one atomic transaction, hold a signed payment to broadcast later, swap stablecoins on the native DEX, and react to incoming payments. Every action is signed by your KeeperHub wallet.

## Quickstart: accept a payment and reconcile by memo

Accept a stablecoin payment on Tempo and automatically mark the matching invoice paid, in about ten minutes. The worked example is the **Tempo Invoice Reconciliation** template.

1. **Use your KeeperHub wallet.** Your organization already has a wallet, and it works on Tempo as-is, with no separate connection to add. On Tempo it signs as an EOA (see [Accounts](#networks-and-accounts) below). Fund it with a Tempo stablecoin so it can pay network fees.
2. **Deploy the template.** Open **Tempo Invoice Reconciliation** from the templates gallery and deploy a copy into your organization.
3. **Configure the inputs.** Set the deposit address to watch (your KeeperHub wallet address), the accounting endpoint the workflow posts to when an invoice is paid, and the receipt email. Optionally set a memo prefix so only payments whose memo starts with your invoice reference trigger the flow.
4. **Enable the workflow.** Once enabled, the **Transfer** trigger subscribes to incoming payments on your deposit address.
5. **Send a test payment.** From any Tempo wallet, send the stablecoin to your deposit address with the invoice reference as the memo.

When the payment lands, the workflow checks the amount, posts to your accounting endpoint to mark the invoice paid, and emails the payer a receipt. Because the memo is an indexed field on the transfer event, the reconciliation is verifiable directly from a block explorer.

## Networks and accounts

| Network | Chain ID | Explorer |
|---------|----------|----------|
| Tempo | `4217` | [explore.mainnet.tempo.xyz](https://explore.mainnet.tempo.xyz) |
| Tempo Testnet | `42431` | [explore.testnet.tempo.xyz](https://explore.testnet.tempo.xyz) |

- **Fees are paid in a stablecoin** from your wallet's own balance. There is no native gas token, so keep a small stablecoin balance for fees.
- **Accounts are EOAs.** Your KeeperHub wallet signs Tempo transactions directly. Safe smart accounts are not available on Tempo; use your KeeperHub wallet.
- **On-chain scanning covers stablecoins** on Tempo.

## Actions

| Action | Description |
|--------|-------------|
| Transfer with Memo | Send a stablecoin payment carrying an on-chain 32-byte memo, with an optional on-chain expiry |
| Batch Payout | Pay many recipients in one atomic transaction, each with its own memo |
| Sign & Hold Payment | Sign a payment now and broadcast it later, manually or at a scheduled time, bounded by an on-chain deadline |
| Swap Stablecoins | Market-swap one Tempo stablecoin for another on the native DEX |

## Trigger

| Trigger | Description |
|---------|-------------|
| Transfer | Fires when a stablecoin payment lands on a watched address, with an optional memo filter for invoice matching |

## Capability matrix

Tempo makes several payment primitives native and default that require extra work elsewhere. This plugin exposes them directly.

| Capability | On Tempo | On other EVM chains |
|------------|----------|---------------------|
| 32-byte transfer memo | Protocol-native and indexed on the transfer event | An app-level convention on top of a plain transfer |
| Atomic batch payout | Native, in a single transaction | Possible via a multicall contract |
| Deferred / scheduled payment | Sign now, broadcast later, bounded by an on-chain settlement deadline | Possible via account abstraction and extra infrastructure |
| Stablecoin swap | Native on-chain DEX | Via a third-party DEX router |
| Fees | Paid in a stablecoin, no native gas token | Paid in the chain's native gas token |
| Accounts | EOA | EOA, and often Safe smart accounts |

## Transfer with Memo

Send a stablecoin payment stamped with an on-chain memo, such as an invoice or pay-run reference.

**Inputs:**
- Network (Tempo or Tempo Testnet) - Required
- Token (the stablecoin to send) - Required
- Amount - Required
- Recipient Address - Required
- Memo - Optional. Plain text (up to 31 bytes) is encoded to a 32-byte memo; a `0x` + 64-hex value is used verbatim (for example, a receipt hash).
- Expire if not settled by - Optional (Advanced). An on-chain expiry: if the transfer is not included by this time it fails instead of lingering. Accepts a fixed date and timezone, a relative offset (for example `+15m` from the run), or a value from another step.

**Outputs:** `success`, `transactionHash`, `transactionLink`, `from`, `to`, `amount`, `memo`, `validBefore`, `chainId`, `error`

**When to use:** Vendor and invoice payments where the memo lets the recipient reconcile the payment automatically.

## Batch Payout

Pay many recipients in one atomic transaction. All payments settle together or none do, and each carries its own memo.

**Inputs:**
- Network - Required
- Token - Required
- Payouts - Required. A JSON array of `{ recipient, amount, memo? }` entries.
- Shared Memo - Optional. Applied to any payment that does not set its own memo (for example, a pay-run id).

**Outputs:** `success`, `transactionHash`, `transactionLink`, `from`, `payoutCount`, `totalAmount`, `chainId`, `error`

**When to use:** Contractor payroll and other scheduled disbursements that must all succeed or all fail together.

## Sign & Hold Payment

Sign a stablecoin payment now and hold the signed transaction to broadcast later, either on demand or at a scheduled time. The on-chain validity window guarantees it can never settle after its deadline.

**Inputs:**
- Network - Required
- Token - Required
- Amount - Required
- Recipient Address - Required
- Memo - Optional. Attached on-chain as an indexed 32-byte topic.
- Release - Required. `Manually` releases the payment from the Held Payments page (organization owner only); `At a scheduled time` broadcasts it automatically at the broadcast time.
- Broadcast At - Required when Release is scheduled (Scheduling group). A fixed date and timezone, a relative offset (for example `+2h` from the run), or a value from another step.
- Valid Before - Optional (Scheduling group). The on-chain deadline after which the payment can no longer settle. Defaults to 24 hours from now for manual holds, or 1 hour past the broadcast time for scheduled holds.

**Outputs:** `success`, `paymentId`, `precomputedHash`, `from`, `to`, `amount`, `memo`, `broadcastMode`, `broadcastAt`, `validBefore`, `status`, `chainId`, `error`

**When to use:** Payments approved now but released later - a manual go/no-go before broadcast, or a scheduled disbursement - where you want a hard on-chain deadline that bounds when settlement can happen.

## Swap Stablecoins

Market-swap one Tempo stablecoin for another on the native DEX, protected by a minimum-output slippage floor.

**Inputs:**
- Network - Required
- Sell Token - Required
- Buy Token - Required
- Amount to Sell - Required
- Max Slippage (bps) - Optional, defaults to 50 (0.5%)

**Outputs:** `success`, `transactionHash`, `transactionLink`, `from`, `tokenIn`, `tokenOut`, `amountIn`, `quotedOut`, `minAmountOut`, `chainId`, `error`

**When to use:** Treasury operations that rebalance between stablecoins before disbursing.

## Transfer trigger

Start a workflow when a stablecoin payment lands on an address you watch.

**Configuration:**
- Network - Required
- Stablecoin Token (the token contract to watch) - Required
- Deposit Address - Required. The address that receives payments; the trigger fires on transfers sent to it.
- Memo Filter - Optional. Matches an exact `0x` + 64-hex memo, or treats plain text as a prefix so a shared invoice reference matches a family of payments.

**Outputs:** the decoded payment as `args.from`, `args.to`, `args.value` (amount in the token's smallest unit), and `args.memo`, plus `transactionHash`, `blockNumber`, and the token `address`.

**When to use:** Invoice reconciliation and any flow that should react to an incoming payment, matched by memo.

## Example: invoice reconciliation

```
Transfer (deposit address, memo prefix = invoice reference)
  -> Condition (amount is at least the invoice total)
  -> HTTP Request (POST to your accounting system: mark the invoice paid)
  -> Send Email (receipt to the payer, with the explorer link)
```
