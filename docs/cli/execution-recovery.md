---
title: "Execution recovery"
description: "KeeperHub CLI Execution recovery"
---

# Execution recovery

Agents and adapters that submit KeeperHub **direct-execution** writes
(`POST /api/execute/transfer`, `POST /api/execute/contract-call`) must recover
safely when the network flakes, a status read races ahead of persistence, or
an on-chain receipt is not successful.

This guide is the published summary of the normative contract in
[`execution-recovery-v1/contract.md`](./execution-recovery-v1/contract.md).

It does **not** describe `POST /api/workflows/<id>/webhook`. That is a
different surface.

## Safe first-write sequence

1. Simulate when available and continue only if the call would not revert.
2. Broadcast once with a stable `Idempotency-Key` that names the **work**, not the attempt.
3. Save `executionId`.
4. Poll `GET /api/execute/{executionId}/status`.
5. Do not infer on-chain success from `status=completed` alone. Treat
   `receipts[].receiptStatus` as the receipt evidence: only `success` is a
   successful receipt. `reverted` and `safe_inner_failure` are conclusive
   failures. `not_found` and `timeout` mean the receipt was unreadable; the
   server settles those rows as `unconfirmed`, not `failed`.

KEEP-966 on the server re-verifies every claimed hash before writing
`completed`. A reverted receipt is stored `verified: false` and the row
settles as `failed`. A client that still sees `completed` plus a non-success
receipt must fail closed — that combination is a defensive invariant, not an
observed production envelope.

## Direct-execution status vocabulary

`pending | running | unconfirmed | completed | failed`

(`app/api/execute/_lib/types.ts`. There is no `queued` status on this endpoint.)

Poll while a row is `pending` or `running`. Stop on `unconfirmed`, `completed`
or `failed`. `unconfirmed` means the transaction was broadcast but no receipt
could be read; the server keeps reconciling that row, so treat it as "stop
waiting and report", not as a failure, and read the settled status later
against the same execution ID.

Workflow run status uses a different vocabulary (`success` / `error` /
`cancelled`) — do not mix it with direct-execution statuses.

## CLI behaviour

- `kh ex transfer` / `kh ex cc` attach `Idempotency-Key` on every write.
  Override with `--idempotency-key` to pin a key across process restarts.
- HTTP 5xx retries reuse that key.
- HTTP 409 `idempotency_in_progress`: retry the **same** key until `--timeout`.
  Do not mint a new key.
- HTTP 409 `idempotency_conflict`: fail. Do not rotate the key (that would
  broadcast a second transaction).
- `--wait` polls the same execution ID and tolerates a **bounded** initial HTTP
  404 until `--timeout` (default 5m). Persistent 404 (wrong id, other org) is
  a timeout error.
- `--watch` does **not** treat 404 as pending. A mistyped or foreign-org id
  exits with an error instead of looping.
- `--wait` and `--watch` stop on `unconfirmed` and report it. `--wait` exits
  **zero** there, printing the status and transaction hash, because a non-zero
  exit invites a re-run that would broadcast a second transaction.
- Wait paths fail when `status=failed`, when a receipt is `reverted` or
  `safe_inner_failure`, and when `status=completed` carries any non-success
  receipt.
- `kh ex status --require-verified` additionally demands chain proof: it exits
  non-zero unless the execution completed carrying at least one receipt and
  every receipt is `verified: true` with `receiptStatus: success`. `unconfirmed`
  fails that gate, and so does a completion with an empty `receipts` array,
  which is treated as success without the flag.

## Fixtures

Golden responses live under `testdata/execution_recovery_v1/` (`version: 1`)
and are loaded by `go test ./internal/execrecovery/...`. Each fixture is
labeled `observed`, `defensive`, or `classifier`.
