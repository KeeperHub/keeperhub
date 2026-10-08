---
title: "Hedera Plugin"
description: "Verify workflow output against Hedera's public consensus via the HCS mirror node."
---

# Hedera Plugin

Anchor-and-verify: a workflow (or any external system) can anchor output to a Hedera Consensus Service topic, and this plugin reads the message back from the **public mirror node** so downstream steps can gate on independently-verifiable proof. What the check proves: Hedera's consensus guarantees the message exists, is immutable, and is ordered — it does not by itself prove who wrote the bytes. On a topic created without a submit key, any funded account can submit matching content; set **Expected Submitter** to bind the result to the account that paid the transaction fee for the message. On a topic without a submit key that fee payer is the author, so `verified` then means the configured system wrote it. On a topic with a submit key the submit key holds authorship and the fee can be paid by a third-party relayer, so the check binds to the payer only: a relayer-paid message from the legitimate author reads as unverified.

## Actions

| Action | Description |
|--------|-------------|
| Verify HCS Message | Read a topic message from the public mirror node and check it against an expected payload |

## Verify HCS Message

Read-only and credential-free: the action queries the public mirror node over HTTPS.

| Input | Required | Description |
|-------|----------|-------------|
| Topic ID | Yes | The HCS topic to read, e.g. `0.0.99999999` |
| Sequence number | Yes | The topic sequence number to verify |
| Expected message | No | When set, `verified` is true only if the anchored payload matches (surrounding whitespace on either side is ignored) |
| Expected submitter | No | When set, `verified` is additionally true only if the mirror records this Hedera account id as the fee payer of the message. Set it whenever `verified` gates a payment, because content alone does not prove authorship on an open topic. It has no effect on its own: `verified` also requires an expected message. The paying account is always reported as the `payerAccountId` output. |
| Network | Yes | `testnet` (default) or `mainnet` — selects which public mirror node is queried |

### Outputs

| Output | Description |
|--------|-------------|
| `found` | True when the mirror holds a message at that sequence (an anchored empty message counts as found) |
| `verified` | True when `found` and the payload matches the expected message (surrounding whitespace on either side is ignored), and, when an expected submitter is configured, the mirror records that account as the fee payer. An expected message is required: with only an expected submitter configured, `verified` is always false, so gate on `payerAccountId` instead |
| `message` | The decoded payload |
| `consensusTimestamp` | The network-assigned consensus timestamp |
| `payerAccountId` | The account that paid the transaction fee for the message, as recorded by the mirror |
| `sequenceNumber` | The verified sequence number |

A `404` from the mirror surfaces as `found: false` with `success: true` when the topic exists, so workflows can branch on "not yet anchored" without treating it as a failure. A `404` for a topic that does not exist is a configuration error and fails the step. Only a `404` means "no such topic": any other probe response — a `429`, a `5xx`, or a request that fails outright (timeout, DNS) — cannot confirm the topic either way, and the step fails with an EXTERNAL-class error instead of guessing. A failed step stops the run — downstream nodes do not execute, and nothing retries it in-run — and the next scheduled run of the workflow tries again, so a mirror outage costs one retry instead of silently polling a mistyped topic as `found: false` forever. On the message query itself, a `429` or `5xx` is a mirror failure (EXTERNAL) and any other `4xx` is a configuration fault (USER) — a 19-digit topic id or a zero sequence number is rejected as the caller's mistake, not counted against the mirror.

Disambiguating those two `404`s costs a second request (a probe of the topic itself), and each request carries a 10-second timeout, so a single run of this step can take up to roughly 20 seconds when nothing is anchored at the requested sequence yet.

Messages larger than the HCS single-transaction payload are split into one chunk per sequence number by the network; a chunked message fails this step with a clear error rather than reporting a content mismatch, because the fragment alone is not the anchored payload.

The step reads nothing it cannot make sense of. A body that is not JSON, that is JSON but not a message object, that carries the mirror's error envelope, that declares or delivers more than 256 KB, or that reports a consensus timestamp or chunk count in an unexpected shape all fail the step with an EXTERNAL-class error. `verified: true` is only ever reported from a well-formed message that the mirror confirms sits at the requested topic and sequence.

## Why verify against a mirror?

Hedera consensus orders messages network-wide and assigns monotonically increasing sequence numbers. Once a message is anchored, nobody can rewrite it — so a workflow that holds payment until `verified: true` is gating on immutability and ordering that any third party can reproduce from the same public endpoint. That proof is complete only when both **Expected Message** and **Expected Submitter** are set: then `verified` also means the mirror records the expected account as the fee payer of that message, which is what binds the bytes to the legitimate system rather than to any third party reproducing them. On a topic that has a submit key, the fee payer and the author can differ, so treat `verified` there as a statement about who paid. The step only reports `verified` when the mirror's response identifies the exact topic and sequence that were requested, and queries go only to Hedera's public mirror nodes.

## Pairing with a submit step

This plugin is read-only by design. To anchor messages, submit to an HCS topic from your own infrastructure using the official [`@hashgraph/sdk`](https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service). Once submitted, the sequence number this plugin verifies is returned by the submission receipt, and the record is explorable on [hashscan.io](https://hashscan.io).
