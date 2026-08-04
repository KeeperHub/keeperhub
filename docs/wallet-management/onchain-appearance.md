---
title: "What Your Transaction Looks Like On-Chain"
description: "Why a workflow transaction can show an unfamiliar sender, an unfamiliar contract, and a value of 0 on a block explorer, and how to verify it correctly."
---

# What Your Transaction Looks Like On-Chain

A workflow ran, KeeperHub reported success, and you opened a block explorer to
check. The transaction shows a sender you do not recognise, a contract you do
not recognise, and a value of 0.

Nothing is wrong. This is what a gas-sponsored write looks like, and this page
explains how to read it.

## The short version

When a write is gas-sponsored, your wallet is not the account that submits the
transaction. A relayer submits it on your behalf and pays the fee, and your
action runs as an internal call inside it.

So on the explorer:

| Field | What you see | Why |
|-------|--------------|-----|
| From | An address you do not recognise | The relayer that submitted and paid for the transaction |
| To | A contract you do not recognise | The contract that executes the call on your wallet's behalf |
| Value | `0` | No native token is attached to the outer call |
| Status | Success | The transaction did what your workflow asked |

Your own action, the transfer or the contract call you configured, is an
**internal call** inside that transaction rather than the top-level one.

## Verify with the transaction hash, not your wallet address

This is the important part.

Use the `transactionHash` (or the explorer link) that KeeperHub reports for the
run. Open that hash directly. It is the authoritative record.

Do **not** verify by opening your wallet address and looking through its
transaction list. A sponsored transaction was not sent by your wallet, so it
does not appear there. The list will look as though nothing happened, even
though the transaction succeeded.

On most explorers, the detail worth checking sits under the transaction's
**Logs**, **Internal Transactions**, or **Token Transfers** tabs. That is where
your actual call and any token movements appear.

## Why the value shows 0

Two things are worth separating.

**The outer call carries no native token.** `Value` is the amount of the chain's
native token attached to the top-level call. A token transfer moves an ERC-20
balance through a contract call, and a contract call usually attaches nothing,
so both show `0` even though assets moved. Check the token transfer list rather
than the value field.

**The fee was not paid by you.** With sponsorship the relayer pays the gas, so
your wallet's native balance is unchanged by the fee.

## Why your wallet may have code on it

If you look up your organization wallet on an explorer, it may show a small
amount of contract code rather than appearing as a plain address, and the
explorer may label it as delegated or as a smart account.

That is expected. On supported networks the wallet is delegated so it can be
operated on your behalf while remaining your wallet, under your address, holding
your assets. The delegation is a one-time setup per network, not something each
workflow repeats.

## When a transaction does come from your wallet

Not every write is sponsored. When sponsorship does not apply, the transaction
is sent directly from your wallet, pays gas from your own native balance, and
appears in your wallet's transaction list in the ordinary way. The conditions
that decide this are listed under
[Gas Management](/wallet-management/gas#when-a-transaction-is-sponsored).

Both routes produce a real transaction with a real hash. Only the shape on the
explorer differs.

## Checklist

If a run reports success but the chain looks wrong:

1. Open the `transactionHash` from the run, not your wallet address.
2. Confirm the status is Success.
3. Look at Logs, Internal Transactions, and Token Transfers for the actual call.
4. Expect the sender and the top-level contract to be addresses you do not
   recognise, and the value to be `0`.

## Related

- [Gas Management](/wallet-management/gas) covers sponsorship, what it pays for,
  and when it applies.
- [Turnkey Integration](/wallet-management/turnkey) covers the wallet itself.
