---
title: "Run Error Codes"
description: "What the error codes on a failed workflow run mean and what to do about them."
---

# Run Error Codes

When a run fails for a reason on KeeperHub's side -- rather than a problem with
your workflow's configuration -- the run logs show a short message with a code
in the form `PREFIX-NNNN`, for example `P-0001`. The code identifies the kind of
problem so support can help quickly if it persists.

Configuration mistakes in your own workflow -- an invalid address, a missing
template variable, a contract call that reverted -- are shown with their full,
actionable message instead of a code. Fix the highlighted step and run again.

## What the codes mean

Almost every coded error is temporary. Unless noted below, the action is the
same: wait a few minutes and try the run again.

| Code | What happened | What to do |
| ---- | ------------- | ---------- |
| `E-0001` | The run timed out. | Try again. |
| `E-0002` | A step failed after repeated attempts. | Try again; if it keeps failing, review that step. |
| `E-0003` | The run hit an internal processing error. | Wait a few minutes and try again. |
| `E-0004` | The run could not be processed. | Wait a few minutes and try again. |
| `N-0001` | A blockchain network provider was temporarily unavailable. | Try again shortly. |
| `N-0002` | A temporary network error interrupted the run. | Wait a few minutes and try again. |
| `P-0001`, `P-0002`, `P-0004`, `P-0005` | The run could not be started. | Try again. |
| `P-0003` | The run stopped unexpectedly. | Try again. |
| `C-0001`, `C-0002` | A temporary internal error. | Wait a few minutes and try again. |
| `C-0003`, `C-0004` | An internal problem on our side. | Our team is notified automatically. Contact support if it keeps happening. |
| `CS-0001`, `BS-0001`, `ES-0001` | A scheduled, block, or event trigger could not be started this time. | These retry automatically -- no action needed. |

If a coded error keeps happening for the same workflow, contact support and
include the code and the time of the run.

## Action failures with structured codes (simulate responses)

Some action failures carry a machine-readable code alongside the message. This
applies to the **simulate** surface only: `/api/execute/transfer`,
`/api/execute/contract-call` and `/api/execute/check-and-execute` responses with
`simulate: true` return it in the `code` field, and MCP simulate results surface
it as a `Reason code:` line. Run steps carry the plain message with no code --
when reading run logs or run webhooks, key on the message text.

### `insufficient_balance` (simulate responses)

**What happened**: the simulator found that the funding address could not cover
the native value the call sends. The comparison is against that value only; the
simulator adds no gas term. A call that sends no native value therefore never
produces this code: when a wallet that cannot cover gas makes such a call fail,
the node's own `insufficient funds` error comes back with no `code`, and with a
`failureKind` of `validation` or `unavailable` rather than `revert`. See
[Direct Execution](/api/direct-execution) for the full response shape.

**Related message on the run path** (plain text, no code): before an EVM write
action signs anything, a gas preflight checks that the funding address holds the
native value plus the minimum gas any transaction costs. When it does not, the
step fails before broadcast with:

```
Insufficient ETH balance. Have: 0.0, Need: 0.000000231. Fund
0x...orgWallet with at least 0.000000231 ETH on this chain and retry.
```

The preflight runs in the Web3 plugin's EVM write actions and in the protocol
actions built on them. Actions on chains with their own transaction path, such
as Tempo, do not run it. Reaching the preflight means the wallet is paying gas
itself -- either the step was never eligible for sponsorship, or a sponsored
attempt fell back (see
[Gas Management -- When sponsorship falls back](/wallet-management/gas)). The
run output does not distinguish the two.

**What to do**: fund the address named in the message with at least the stated
shortfall, then retry. For a write that sends no native value, restoring the
sponsorship conditions (gas credits, supported network, direct-wallet sender,
public mempool) can also fix the run without funding. A write that sends native
value always needs that value in the wallet; sponsorship covers the fee only.
