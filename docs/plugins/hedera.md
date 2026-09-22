---
title: "Hedera Plugin"
description: "Verify workflow output against Hedera's public consensus via the HCS mirror node."
---

# Hedera Plugin

Anchor-and-verify: a workflow (or any external system) can anchor output to a Hedera Consensus Service topic, and this plugin reads the message back from the **public mirror node** so downstream steps can gate on independently-verifiable proof. The verification channel trusts only the Hedera network — not the system that submitted the message.

## Actions

| Action | Description |
|--------|-------------|
| Verify HCS Message | Read a topic message from the public mirror node and check it against an expected payload |

## Verify HCS Message

Read-only and credential-free: the action queries the public mirror node over HTTPS.

| Input | Required | Description |
|-------|----------|-------------|
| Topic ID | Yes | The HCS topic to read, e.g. `0.0.10590142` |
| Sequence number | Yes | The topic sequence number to verify |
| Expected message | No | When set, `verified` is true only if the anchored payload matches (surrounding whitespace on either side is ignored) |
| Network | Yes | `testnet` (default) or `mainnet` — selects which public mirror node is queried |

### Outputs

| Output | Description |
|--------|-------------|
| `found` | True when the mirror holds a message at that sequence (an anchored empty message counts as found) |
| `verified` | True when `found` and the payload matches the expected message (surrounding whitespace on either side is ignored) |
| `message` | The decoded payload |
| `consensusTimestamp` | The network-assigned consensus timestamp |
| `sequenceNumber` | The verified sequence number |

A `404` from the mirror surfaces as `found: false` with `success: true` when the topic exists, so workflows can branch on "not yet anchored" without treating it as a failure. A `404` for a topic that does not exist is a configuration error and fails the step, so while the mirror is healthy a polling workflow cannot loop forever on a mistyped topic id. Only a `404` means "no such topic": the topic probe reads any other response — including a `429` or a `5xx`, or a request that fails outright — as "topic exists", so during a mirror outage a mistyped topic id polls as `found: false` rather than failing. That bias is deliberate: surfacing a transient mirror error as a topic error would turn one hiccup into a step failure and break the branch-on-`found: false` pattern this action exists for. On the message query itself, a non-`404` error status is reported as a mirror failure.

Disambiguating those two `404`s costs a second request (a probe of the topic itself), and each request carries a 30-second timeout, so a single run of this step can take up to roughly 60 seconds when nothing is anchored at the requested sequence yet.

Messages larger than the HCS single-transaction payload are split into one chunk per sequence number by the network; a chunked message fails this step with a clear error rather than reporting a content mismatch, because the fragment alone is not the anchored payload.

## Why verify against a mirror?

Hedera consensus orders messages network-wide and assigns monotonically increasing sequence numbers. Once a message is anchored, nobody can rewrite it — so a workflow that holds payment until `verified: true` is gating on proof any third party can reproduce from the same public endpoint. The step only reports `verified` when the mirror's response identifies the exact topic and sequence that were requested, and queries go only to Hedera's public mirror nodes.

## Pairing with a submit step

This plugin is read-only by design. To anchor messages, submit to an HCS topic from your own infrastructure using the official [`@hashgraph/sdk`](https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service). Once submitted, the sequence number this plugin verifies is returned by the submission receipt, and the record is explorable on [hashscan.io](https://hashscan.io).
