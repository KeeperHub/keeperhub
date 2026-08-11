# System Error Codes & Phantom Executions (KEEP-693)

Internal design spec. The complete, authoritative code index lives in section 6.
Runtime source of truth is `lib/errors/error-codes.ts`; this doc must be kept in
sync with that module (a drift check is part of the test suite).

## 1. Problem

When a workflow run fails for a reason the user did not cause -- a node rotation
drops the network, an execution pod never starts, the dispatcher is down -- the
run logs today either show a raw internal message or "No steps recorded". Run #48
in the ticket failed with "No steps recorded" during a cluster node rotation.

We want every system/infra failure that touches a workflow execution to surface a
short, stable, not-overly-revealing **error code** (`PREFIX-NNNN`) plus a concise
customer message. User-configuration failures keep showing their existing
actionable message -- codes are for system failures only.

A second class of failure produces **no execution row at all**: the schedulers and
the event tracker enqueue to SQS and the executor creates the row on dequeue, so a
failure upstream of the executor (scheduler can't enqueue, dispatcher pod down)
leaves nothing in the run logs. We close that gap with **phantom execution rows**.

## 2. Current architecture (as-built, for reference)

- `workflow_executions` already has `error`, `error_category` (11-value enum) and
  `error_type` (`user`/`system`). No `error_code` column.
- `lib/errors/classify.ts` `classifyExecutionError(message)` maps an error message
  to `{errorCategory, errorType}` via ordered regex rules; default
  `workflow_engine`/`system`. This is the single classification chokepoint.
- Error classification is persisted at four sites: `executor/logging.ts`
  (terminal finalize), `execute-in-background.ts`, `app/api/internal/reaper`
  (stuck/timeout -- the "No steps recorded" path), and the marketplace
  `app/api/mcp/workflows/[slug]/call` route.
- `keeperhub-executor` (the dispatcher) dequeues an SQS message, calls
  `generateId()`, **inserts a `pending` row** (`index.ts:346`), then dispatches to
  k8s-job / in-process / api. On dispatch failure it updates the row to `error`
  but does **not** set category/type (a gap). There is already a precedent for
  synthetic rows: the feature-guard-blocked path (`index.ts:290`) inserts a
  `status:"error"` row "so the trigger does not silently vanish".
- `keeperhub-scheduler` (block + cron dispatchers) and `keeperhub-events` have
  **no DB access** -- they only use the SQS SDK and call internal API endpoints
  with an `X-Service-Key` header. Phantom creation from a satellite must therefore
  go through an internal API route, not a direct DB write.
- `POST /api/internal/executions` creates a row (forces `status:"running"`, runs
  feature + execution-limit guards, returns `executionId`). `PATCH
  /api/internal/executions/[executionId]` updates status (allows
  `running|success|error` only).

## 3. Taxonomy

Format: `PREFIX-NNNN`, prefix from Simon's first-letter scheme. Codes attach only
when `error_type = system`. User-config failures get no code.

| Prefix | Component            | Source of failure                                              |
| ------ | ------------------- | -------------------------------------------------------------- |
| `E-`   | Executor runtime    | workflow ran but hit an engine fault (timeout, retries, nonce) |
| `N-`   | Network             | RPC drop, DNS, connection reset -- cross-cutting               |
| `P-`   | Pod / infra         | pod/runtime didn't start, k8s job create failed, SIGTERM/OOM   |
| `C-`   | Common / shared     | database, internal auth/secret, missing module/config          |
| `CS-`  | Cron scheduler      | scheduled trigger failed to dispatch (phantom-origin)          |
| `BS-`  | Block scheduler     | block trigger failed to dispatch (phantom-origin)              |
| `ES-`  | Event scheduler     | event trigger failed to dispatch (phantom-origin)              |

`E/N/P/C` map mechanically from the existing classifier categories
(`network_rpc->N`, `database|auth|missing-secret->C`, `workflow_engine->E`,
`infrastructure SIGTERM->P`). `CS/BS/ES` are assigned at the satellite when an
enqueue fails. The reconciler assigns a `P-` code to phantoms that were enqueued
but never picked up (cause is downstream of the satellite).

## 4. Phantom execution rows

Decision: **unified row** (the satellite owns the id; the executor upgrades the
existing row) + **proactive** (a phantom is created for every expected trigger).

### 4.1 New status value

Add `phantom` to the execution status union:
`pending | running | success | error | cancelled | phantom`. `phantom` is the
initial state, before `pending`. It is volume-neutral for successful runs: row
creation simply moves from executor-dequeue to satellite-trigger time. The only
genuinely new rows are triggers that previously vanished.

### 4.2 Lifecycle

```
satellite decides to fire
  -> POST /api/internal/executions {status:phantom}  -> returns executionId
  -> enqueue SQS message WITH executionId
       (if phantom create fails: enqueue WITHOUT executionId -> legacy insert path)

executor dequeues
  -> if message has executionId:
        UPDATE ... SET status='pending' WHERE id=executionId AND status='phantom'
        (CAS; if 0 rows -> row missing/already advanced -> insert fallback)
     else: insert pending row (current behaviour, backward compatible)
  -> feature-guard / concurrency checks as today (block -> phantom|pending -> error)
  -> dispatch

run proceeds: pending -> running -> success|error  (unchanged, keyed by id)

reconciler (extended reaper), phantom older than PHANTOM_THRESHOLD (5 min):
  -> still status='phantom' -> never picked up
     -> status='error', error_code = P-0005, classify as workflow_engine/system
```

### 4.3 Enqueue-failure path (the CS/BS/ES codes)

When the satellite catches an enqueue error after creating the phantom, it
immediately resolves the phantom to a failure with the scheduler-specific code:

```
PATCH /api/internal/executions/{id} {status:error, errorCode: CS-0001|BS-0001|ES-0001}
```

If the failure is specifically a network/DNS error reaching SQS, the satellite may
send `N-0002` instead. Best-effort: a failed PATCH does not block the loop; the
reconciler will still age the phantom out to `P-0005`.

### 4.4 Backward compatibility / rollout

- `executionId` is **optional** on the SQS message types. Messages enqueued by an
  old satellite (in flight across a deploy) have no id -> executor uses the legacy
  insert path. No coordinated deploy required.
- The CAS upgrade with insert-fallback means a missing/duplicate phantom never
  drops a real run.
- `error_code` is a nullable column; legacy rows stay null. No backfill.

### 4.5 API changes

- `POST /api/internal/executions`: accept optional `status:"phantom"`. When
  phantom, **skip the execution-limit guard** (quota is charged when it upgrades
  to running, not at trigger intent) but keep the soft-delete and feature checks.
  Return `executionId` as today.
- `PATCH /api/internal/executions/[executionId]`: accept optional `errorCode`
  (validated against the registry) and write it alongside `error`. Allow the
  transition from `phantom`.
- Reaper route: add a third stale predicate for `status='phantom'` older than the
  phantom threshold; set `error_code = P-0005`.

## 5. Persistence sites for `error_code`

Every site that already writes `error_category`/`error_type` also writes
`error_code`, derived from the same `classifyExecutionError` call (extended to
return `code`):

1. `lib/workflow/executor/logging.ts` -- terminal finalize (main path: E/N/P/C).
2. `lib/workflow/execute-in-background.ts` -- kickoff failure.
3. `app/api/internal/reaper/route.ts` -- stuck/timeout (P-0001) + phantom-aged (P-0005).
4. `app/api/mcp/workflows/[slug]/call/route.ts` -- marketplace payment failure.
5. `keeperhub-executor/index.ts` -- dispatch failure (P-0004) and k8s job create
   failure (P-0002); also classify these (currently unclassified). Feature-guard
   block keeps its billing/user classification (no system code).
6. Satellite enqueue-failure PATCH -- CS/BS/ES-0001 (section 4.3).

## 6. Complete code index (authoritative)

Mirror of `lib/errors/error-codes.ts`. `retryable` drives the customer message
("wait and retry" vs "contact support"). `customerMessage` is what the run-log UI
shows; it never reveals internal detail.

| Code     | Component        | Retryable | Cause (internal)                                             | Classifier category   | Customer message |
| -------- | ---------------- | --------- | ----------------------------------------------------------- | --------------------- | ---------------- |
| `C-0001` | Common           | yes       | Default for unmatched system failures                       | workflow_engine       | Internal error (C-0001). Please wait a few minutes and try again. |
| `C-0002` | Common           | yes       | Database unavailable / query failed                         | database              | Internal error (C-0002). Please wait a few minutes and try again. |
| `C-0003` | Common           | no        | Missing service config/secret/module ("must be set")        | infrastructure        | Internal error (C-0003). Our team has been notified; please contact support if it persists. |
| `C-0004` | Common           | no        | Internal authentication / secret-store failure              | auth                  | Internal error (C-0004). Our team has been notified; please contact support if it persists. |
| `E-0001` | Executor         | yes       | Execution timed out                                         | workflow_engine       | The run timed out (E-0001). Please try again. |
| `E-0002` | Executor         | yes       | Step exceeded max retries                                   | workflow_engine       | A step failed repeatedly (E-0002). Please try again. |
| `E-0003` | Executor         | yes       | Engine fault (unknown action, drain timeout)                | workflow_engine       | Internal error (E-0003). Please wait a few minutes and try again. |
| `E-0004` | Executor         | yes       | Message processing failed (executor consumer backstop)      | infrastructure        | The run could not be processed (E-0004). Please wait a few minutes and try again. |
| `N-0001` | Network          | yes       | RPC endpoint unavailable                                    | network_rpc           | A network provider was unavailable (N-0001). Please try again shortly. |
| `N-0002` | Network          | yes       | Network connectivity error (DNS / reset / timeout)          | network_rpc           | Internal network error (N-0002). Please wait a few minutes and try again. |
| `P-0001` | Pod              | yes       | Execution did not start (pending, no steps -- reaper)       | workflow_engine       | The run could not be started (P-0001). Please try again. |
| `P-0002` | Pod              | yes       | Execution environment failed to start (k8s job create)      | infrastructure        | The run could not be started (P-0002). Please try again. |
| `P-0003` | Pod              | yes       | Execution terminated unexpectedly (SIGTERM / OOM)           | infrastructure        | The run stopped unexpectedly (P-0003). Please try again. |
| `P-0004` | Pod              | yes       | Dispatch failed (executor outer catch)                      | infrastructure        | The run could not be started (P-0004). Please try again. |
| `P-0005` | Pod              | yes       | Trigger was never picked up (phantom aged out -- SQS lost)  | infrastructure        | The run could not be started (P-0005). Please try again. |
| `CS-0001`| Cron scheduler   | yes       | Scheduled trigger failed to dispatch                        | workflow_engine       | The scheduled run could not be started (CS-0001). It will retry automatically. |
| `BS-0001`| Block scheduler  | yes       | Block trigger failed to dispatch                            | workflow_engine       | The run could not be started (BS-0001). It will retry automatically. |
| `ES-0001`| Event scheduler  | yes       | Event trigger failed to dispatch                            | workflow_engine       | The run could not be started (ES-0001). It will retry automatically. |

The public docs page (docs/) carries a curated subset of this table with
user-facing language only -- no component column, no internal cause, no classifier
category.

## 7. UI

- `lib/errors/customer-message.ts` (already added): extend to look up the code in
  the registry and return `customerMessage`. Falls back to the existing generic
  strings when `error_code` is null but `error_type=system`.
- Thread `errorCode` through `lib/api-client.ts` and `components/workflow/workflow-runs.tsx`.
- Map `status:'phantom'` to the existing pending/queued display so an in-flight
  phantom looks like a queued run until it upgrades or ages out.

## 8. Public docs (docs/)

Curated subset under `docs/keeper-runs/` (run-facing section), registered in the
section `_meta.ts`. User language only; lists the codes a user may see and "what
to do" (wait/retry, or contact support). No internal architecture.

## 9. Commit sequence (single PR)

1. This spec + `lib/errors/error-codes.ts` registry + classifier `code` extension
   + drift test.
2. Schema: `phantom` status + `error_code` column + drizzle migration.
3. Persist `error_code` at the existing app-side sites (logging, background,
   reaper, mcp call) + reaper phantom predicate (P-0005).
4. Internal API: phantom create (POST) + errorCode on PATCH.
5. Executor: read `executionId`, CAS upgrade with insert fallback, classify +
   code on dispatch/k8s failures.
6. Satellites: generate id via phantom create, put id in SQS message, PATCH
   CS/BS/ES on enqueue failure (best-effort).
7. UI: code display + phantom status mapping.
8. Public docs subset.
9. Tests across the above.

## 10. Open risks

- **Satellite hot-path latency**: phantom create is a synchronous internal API
  call per trigger. Block dispatch can be high-frequency. Mitigation: best-effort
  (failure falls back to legacy enqueue), and we watch row/QPS after rollout.
- **Phantom leak**: any bug that creates phantoms but never upgrades/ages them
  would accumulate rows. The reconciler is the backstop; alert on phantom count.
- **Code/category coupling**: codes are derived from the message-pattern
  classifier, so a new failure family lands on `C-0001` until a rule is added --
  same failure mode as the existing classifier default.
