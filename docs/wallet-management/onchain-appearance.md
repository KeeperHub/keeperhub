---
title: "What Your Transaction Looks Like On-Chain"
description: "How a workflow transaction appears on a block explorer, why the sender and the fee differ between sponsored networks and Tempo, and how to verify a run correctly."
---

# What Your Transaction Looks Like On-Chain

A workflow ran, KeeperHub reported success, and you opened a block explorer to
check. What you see there depends on the network.

A write takes one of two shapes. On a gas-sponsored network the transaction is
submitted by a relayer, so the sender is an address you do not recognise. On
every other network, Tempo included, the transaction is sent by your own wallet
and the sender is your own address. Both are normal. This page explains how to
read each one.

## Which shape applies

| Network | Shape |
|---------|-------|
| Ethereum, Base, Polygon, Arbitrum, and their testnets | Sponsored, when the [conditions](/wallet-management/gas#when-a-transaction-is-sponsored) are met |
| Tempo | Sent from your own wallet |
| Any other network | Sent from your own wallet |

Sponsorship is conditional even on a supported network. If it does not apply to
a given run, that transaction takes the direct shape instead.

## A sponsored write

Your wallet is not the account that submits the transaction. A relayer submits
it on your behalf and pays the fee, and your action runs as an internal call
inside it.

| Field | What you see | Why |
|-------|--------------|-----|
| From | An address you do not recognise | The relayer that submitted and paid for the transaction |
| To | A contract you do not recognise | The contract that executes the call on your wallet's behalf |
| Value | `0` | No native token is attached to the outer call |
| Status | Success | The transaction did what your workflow asked |

Your own action, the transfer or the contract call you configured, is an
**internal call** inside that transaction rather than the top-level one.

## A write sent from your own wallet

| Field | What you see | Why |
|-------|--------------|-----|
| From | Your own wallet address | Your wallet signed and submitted the transaction |
| To | The contract or recipient you configured | Your action is the top-level call |
| Value | `0` for a token transfer or contract call | Token movements are not native value; see below |
| Status | Success | The transaction did what your workflow asked |

Because your wallet is the sender, the transaction also appears in your
wallet's own transaction list on the explorer.

## Who pays the fee, and in what

This is the part that differs most between networks.

**Sponsored.** The relayer pays the gas in the network's native token. Your
wallet's native balance is unchanged by the fee, and the fee never appears as a
debit against your address.

**Sent from your own wallet, on a network with a native token.** Gas comes out
of your own native balance in the usual way.

**Sent from your own wallet, on Tempo.** Tempo has no native gas token. The fee
is paid in a stablecoin from your own balance and appears as a token transfer
inside the same receipt as your payment.

That last case is worth reading deliberately if you are doing agent
accounting. Because the fee is denominated in the same stablecoin you are
moving, cost and revenue arrive in one unit: you can read both off the same
receipt and close the books without a conversion step. Keep a small stablecoin
balance in the wallet so it can cover fees.

## Verify with the transaction hash, not your wallet address

Use the `transactionHash` (or the explorer link) that KeeperHub reports for the
run. Open that hash directly. It is the authoritative record on every network.

Do **not** verify by opening your wallet address and looking through its
transaction list. A sponsored transaction was not sent by your wallet, so it
does not appear there. The list will look as though nothing happened, even
though the transaction succeeded.

On most explorers, the detail worth checking sits under the transaction's
**Logs**, **Internal Transactions**, or **Token Transfers** tabs. That is where
your actual call, any token movements, and on Tempo the fee transfer appear.

## Why the value shows 0

`Value` is the amount of the chain's native token attached to the top-level
call. A token transfer moves an ERC-20 balance through a contract call, and a
contract call usually attaches nothing, so both show `0` even though assets
moved. This holds in both shapes. Check the token transfer list rather than the
value field.

## Why your wallet may have code on it

If you look up your organization wallet on an explorer, it may show a small
amount of contract code rather than appearing as a plain address, and the
explorer may label it as delegated or as a smart account.

That is expected. On supported networks the wallet is delegated so it can be
operated on your behalf while remaining your wallet, under your address, holding
your assets. The delegation is a one-time setup per network, not something each
workflow repeats.

## Checklist

If a run reports success but the chain looks wrong:

1. Open the `transactionHash` from the run, not your wallet address.
2. Confirm the status is Success.
3. Look at Logs, Internal Transactions, and Token Transfers for the actual call.
4. Check the sender against the shape for that network. On a sponsored network,
   expect a sender and a top-level contract you do not recognise. On Tempo and
   elsewhere, expect your own address.
5. Expect a value of `0` for token transfers and contract calls either way.

## Related

- [Gas Management](/wallet-management/gas) covers sponsorship, what it pays for,
  and when it applies.
- [Tempo](/plugins/tempo) covers stablecoin payments, memos, and fees on Tempo.
- [Turnkey Integration](/wallet-management/turnkey) covers the wallet itself.
