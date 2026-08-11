---
title: "Zero to a Verified Onchain Transaction"
description: "Take a new integration from MCP setup to a transaction you have independently confirmed landed onchain."
---

# Zero to a Verified Onchain Transaction

Most quickstarts stop when the API accepts your request. This guide continues to the
part that actually matters: proving a transaction landed, and knowing what to do when
the answer is ambiguous.

It assumes a testnet throughout. Nothing here asks you to paste a private key.

## 1. What "verified" means here

A request that returned `202 Accepted` proves only that KeeperHub queued work. Treat a
transfer as landed when all of the following hold:

- the execution reports a `transactionHash`
- `GET /api/execute/{executionId}/status` returns `status: "completed"`
- the matching `receipts[]` entry has `verified: true` and `receiptStatus: "success"`
- the effect you intended is visible onchain (a `Transfer` log, a balance change)

KeeperHub already re-fetches each receipt from the chain before an execution settles, so
`receipts[]` is evidence rather than a restatement of `status`. Checking the same hash
against your own RPC is still worth doing once while you are building the integration:
it tells you that your understanding of the transaction matches the chain's, and it is
the check you will want in place the first time a result looks strange.

## 2. Prerequisites

- An organization API key (`kh_`). See [API Keys](/api/api-keys).
- A configured wallet integration. Without one, execution returns `422` with
  `WALLET_NOT_CONFIGURED`.
- A testnet chain that is enabled for your org. Read `GET /api/chains` and pick one
  where `isEnabled` and `isTestnet` are both `true` (Ethereum Sepolia is `11155111`).
- Testnet funds in whichever account actually pays. Section 4 is about identifying it.
- An RPC endpoint for that chain, for the independent check in section 8.

Keep the key in an environment variable. Never inline it in a command you will paste
into an issue or a commit.

## 3. Connect

The agent-native surface is the MCP server:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

See [MCP Server](/agent/mcp-server) for OAuth and per-workflow servers.

A non-destructive way to confirm the connection works is `list_integrations`, which
reads and changes nothing. If it returns `401`, the key or header is wrong; a `403` on a
tool you expected to have means the token's scope is too narrow.

## 4. Know which account is which

This is the step most first integrations skip, and the one that makes later errors hard
to read. Four roles are easy to conflate, and they are frequently different addresses:

| Role | What it does |
| --- | --- |
| Turnkey EOA | signs and broadcasts the outer transaction, and pays gas |
| Safe | `msg.sender` at the target contract, when signer routing is on |
| Zodiac Roles modifier | validates the call against an allowlist and per-token allowances, when enabled |
| Token holder | the account whose balance actually decreases |
| Recipient | where the tokens end up |

With the Safe **Sender** toggle off, writes sign directly from the Turnkey EOA, which is
also the token holder. One address plays several roles and reasoning stays simple.

With the toggle on, they separate: the EOA still signs the outer transaction, but the
Safe is `msg.sender` at the target and the Safe holds the funds. See
[Safe Smart Accounts](/wallet-management/safe) for the two routing modes.

That distinction matters immediately in the next section, because the dry run does not
model it: simulation resolves its sender to the org's wallet address, so for a
Safe-routed org the simulated sender is not the account that pays. See
[Known limitation](/api/direct-execution#known-limitation).

Write these addresses down before you continue. Every confusing result later in this
guide resolves by asking which of them a message is talking about.

## 5. Preflight

Confirm, in order:

- the chain id is the testnet you chose, and `isEnabled` is true
- the token address is that token on *that* chain
- the amount is in human-readable units (`"0.1"`), not base units
- the account that actually holds the token has enough of it
- the recipient is an address you control

## 6. Simulate

Every execute tool and endpoint takes a `simulate` flag that estimates gas and catches
reverts without signing or broadcasting:

```json
{
  "chainId": "11155111",
  "recipientAddress": "0xRecipient",
  "tokenAddress": "0xToken",
  "amount": "0.1",
  "simulate": true
}
```

`simulate` must be the JSON boolean `true`. The string `"true"` is rejected, deliberately,
so a typo cannot fall through to a real broadcast.

A dry run that would revert answers **HTTP 400 with `wouldRevert: true`**. That status
describes the transaction, not your request: the simulation ran, and the body carries the
decoded reason. A wrapper that treats every non-2xx as "bad request" throws away the
answer. Read `wouldRevert` before classifying a 400 from these endpoints.

Over MCP the same information arrives as an error whose text names the stage, the decoded
reason, any machine-readable `code`, and the account the dry run used as sender.

A successful dry run is not a guarantee of execution. It proves the call does not revert
against current state, at the sender the simulator chose. State can change, and for a
Safe-routed org that sender is not the paying account.

## 7. Execute

Broadcast by re-sending the request you just simulated, with `simulate` removed and an
`Idempotency-Key` header added:

```bash
curl -X POST https://app.keeperhub.com/api/execute/transfer \
  -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  -H "Idempotency-Key: first-verified-transfer-2026-08-08" \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": "11155111",
    "recipientAddress": "0xRecipient",
    "tokenAddress": "0xToken",
    "amount": "0.1"
  }'
```

Change nothing else between the dry run and the broadcast, so the transaction you
inspected is the transaction you send. The key must name the *work*, not the attempt, so
a retry reuses it: see [Choosing a stable key](/api/direct-execution#choosing-a-stable-key).

Save the returned `executionId`.

## 8. Verify

Poll the status endpoint, honouring the `X-Poll-Interval-Hint` header rather than a fixed
timer. A hint of `0` means the execution is terminal.

```bash
curl -H "Authorization: Bearer $KEEPERHUB_API_KEY" \
  https://app.keeperhub.com/api/execute/$EXECUTION_ID/status
```

Read the receipt entry, not just the top-level status:

- `verified: true` — this hash positively confirmed onchain
- `receiptStatus: "success"` — it did not revert
- `blockNumber`, `gasUsed` — read from the fetched receipt

`receiptStatus` also takes the values `reverted`, `safe_inner_failure` (the outer
transaction succeeded but a wrapped inner call failed), `not_found`, and `timeout`.
`safe_inner_failure` is the one to watch for on a Safe-routed setup: a transaction that
"succeeded" at the top level while the inner transfer did not.

Then check the same hash yourself, against your own RPC: fetch the receipt, confirm the
status, and decode the `Transfer` log to confirm the token, recipient, and amount are what
you intended. Confirming the *effect* is a stronger statement than confirming the
transaction executed.

What each stage licenses you to say:

| Signal | What it proves |
| --- | --- |
| `202 Accepted` | the request was queued |
| `status: "simulated"`, `wouldRevert: false` | the call did not revert against current state |
| `transactionHash` present | a transaction was claimed |
| `status: "unconfirmed"` | it was broadcast but its receipt is not yet readable — not a failure |
| `status: "completed"` | every claimed hash verified onchain |
| `receiptStatus: "success"` | that transaction did not revert |
| expected log decoded | the intended effect happened |

## 9. When the result is ambiguous

A timeout, a dropped connection, or `receiptStatus: "timeout"` means you do not know the
outcome. It does not mean the transfer failed.

KeeperHub models this state directly. When a broadcast transaction's receipt cannot be
read conclusively, the execution settles as `unconfirmed`, which is **non-terminal**: the
status endpoint keeps telling you to poll rather than handing you an outcome, and the
record carries the hash. Do not re-send an `unconfirmed` execution — the transaction may
still land, and re-sending can move the funds twice.

Do not retry blindly. Instead:

1. Look for a `transactionHash` or `executionId` you already hold.
2. Ask the chain about that hash directly.
3. If you must re-send, re-send with the **same** `Idempotency-Key`, so a replay returns
   the original result instead of executing twice. A replayed response carries
   `idempotentReplay: true`.
4. Treat a missing receipt as unknown, not as failure.

Never convert absence of evidence into a success.

## 10. Troubleshooting

**HTTP 400 on a dry run.** Symptom: a non-2xx that a generic wrapper reports as a bad
request. Likely cause: the simulation ran and the call would revert. How to inspect: read
`wouldRevert` and `revertReason` in the body; over MCP, read the diagnostic lines on the
error. Safe next step: fix the cause and re-simulate. Do not broadcast to "see what
happens".

**The reported balance does not match what you expect.** Symptom: a shortfall or
insufficient-balance reason naming an address that looks wrong. Likely cause: the dry run
resolved the sender to the org wallet, while a Safe holds the tokens. How to inspect:
compare the sender in the diagnostic against the addresses from section 4. Safe next
step: resolve your org's signer mode first; do not fund an address just because a message
named it.

**`422 WALLET_NOT_CONFIGURED`.** No wallet integration. See
[Wallet Management](/wallet-management/turnkey).

**`403` on a tool that used to work.** An OAuth token whose scope is too narrow.
Broadcasting needs `mcp:write`; a dry run only needs `mcp:read`.

**`completed` but the effect is missing.** Check `receiptStatus` for
`safe_inner_failure`, and decode the logs rather than trusting the top-level status alone.

## 11. Checklist

1. Testnet chain id chosen, `isEnabled` and `isTestnet` both true
2. Wallet integration configured
3. Addresses identified: signer, Safe, Roles modifier, token holder, recipient
4. Token address correct for that chain, amount in human-readable units
5. The account that actually holds the token is funded
6. Dry run returns `wouldRevert: false`
7. Same body broadcast, `simulate` removed, `Idempotency-Key` set
8. `executionId` saved
9. `status: "completed"` with `verified: true` and `receiptStatus: "success"`
10. Expected log decoded against your own RPC
