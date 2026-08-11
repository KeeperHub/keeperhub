# `test_workflow` MCP Tool Design

> STATUS: Awaiting approval. Approval required before any test_workflow execution code lands.
> `prepare_test_pin_data` (Phase 49 Plan 02) is introspection-only and does not require this approval.

**Status:** Draft - awaiting approval (see §11)
**Authors:** KeeperHub team
**Created:** 2026-05-16
**Phase:** v1.12 / KEEP-436 sub-item #3
**Linear:** KEEP-436
**Related:** specs/mcp-server/, .planning/research/ARCHITECTURE.md (Sub-item #3), .planning/research/PITFALLS.md (Pitfalls #4, #5, #9, #14)

---

## 1. Goal and Motivation

`test_workflow` is a planned MCP tool that lets agents dry-run a Web3 workflow without spending gas, without triggering payments, and without persisting real execution rows. The tool accepts a workflow ID, optional per-node pin data, and an execution mode, then walks the workflow graph using mock or `eth_call`-backed data for on-chain steps, and returns a full per-node result set.

The motivation is feedback loop speed. Today an agent iterating on a workflow configuration must either (a) pay gas on a testnet for every write-action test, which is slow and irreversible, or (b) use `call_workflow` on a listed workflow, which writes a real `workflow_executions` row, accrues to the creator's earnings report, and (for paid listings) requires a payment. Both paths are too expensive for rapid iteration. A gas-free, payment-free, persistence-free test path cuts the iteration loop from minutes to seconds.

The beneficiaries span three roles. Agent authors get immediate feedback on whether their workflow configuration produces the expected output shape before calling it in production. Creators of listed workflows can validate that the pin data they declare for their workflow matches the plugin step fields their nodes actually expect, catching shape mismatches before paying customers discover them. The platform reduces accidental misconfigured workflows reaching production by giving authors a cheap pre-flight check that exercises the same plugin dispatch logic the real executor uses.

---

## 2. Scope

**In scope (ships in Phase 49):**

The PILOT tool `prepare_test_pin_data` ships in plan 49-02. It is introspection-only: it accepts a workflow ID, reads each node's action type from the plugin registry via `getAllIntegrations()` and `flattenConfigFields()` from `plugins/registry.ts`, and returns a per-node JSON Schema the caller can populate with test values. It makes no execution calls, writes nothing to the database, and calls no plugin step `execute()` functions.

This design document is the second deliverable in Phase 49. The document is the merge gate for any future execution code per TESTWF-04.

**Future scope (deferred until §11 approval):**

- `test_workflow({ workflowId, pinData, executionMode? })` execution tool - gated on user approval in §11
- The `workflow_test_pins` Postgres table (see §5)
- A separate `/api/mcp/workflows/[slug]/test` route (see §4, §9)

**Explicitly out of scope (any phase):**

- Modifying `app/api/mcp/workflows/[slug]/call/route.ts` for test mode - see §4 Hard Constraint 2
- Any code path that calls `recordPayment(...)` from `lib/payments/x402/payment-gate.ts` for a test execution - see §4 Hard Constraint 1
- Sharing executor code between test and production execution paths at the call-route level - see §8

---

## 3. API Contract

The following describes the FUTURE `test_workflow` contract. No code ships this phase.

**HTTP endpoint:**

```
POST /api/mcp/workflows/[slug]/test
Authorization: Bearer <session-jwt or kh_<apikey>>

Request:
{
  workflowId: string,
  pinData: { [nodeId: string]: unknown },   // per-node pinned inputs
  executionMode?: "mock-only" | "eth-call-fallback"  // default: "eth-call-fallback"
}

Response (200):
{
  executionId: string,                       // synthetic ID with `test-` prefix
  status: "completed" | "failed",
  nodeResults: Array<{
    nodeId: string,
    nodeName: string,
    input: unknown,
    output: unknown,
    status: "success" | "error" | "skipped",
    mockedFields: string[],                  // dot-paths of fields populated from pin data
    executionMode: "real" | "mock" | "eth_call"
  }>,
  durationMs: number
}
```

**MCP tool registration:**

The `test_workflow` MCP tool will be registered in `lib/mcp/tools.ts` inside `registerMetaTools`, modeled after Phase 48's `validate_workflow` registration. It will use the `withScopeCheck` and `withToolLogging` wrappers that every tool in the file applies. The tool will be added to `WRITE_TOOLS` in `lib/mcp/oauth-scopes.ts` (since test execution creates a test execution row), NOT `READ_TOOLS`. The distinction mirrors how `create_workflow` and `update_workflow` sit in `WRITE_TOOLS` while `get_workflow` and `list_workflows` sit in `READ_TOOLS`.

The `prepare_test_pin_data` introspection tool (which DOES ship this phase in plan 49-02) goes in `READ_TOOLS` per TESTWF-06, because it only reads from the plugin registry and workflow definition - it writes nothing.

---

## 4. Hard Constraints

These constraints are REQUIREMENTS, not suggestions. Any future implementation PR that violates them must be rejected at review.

**Constraint 1: Zero writes to `workflow_payments` during any test_workflow call (TESTWF-03).**

Synthetic tx hashes from test runs that hit the `workflow_payments` insert path would (a) appear as phantom revenue in creator earnings dashboards, corrupting reported metrics, and (b) collide with the `payment_hash` UNIQUE constraint, silently dropping a real payment. The `recordPayment` function in `lib/payments/x402/payment-gate.ts` swallows Postgres unique violation code 23505 - if a synthetic payment hash from a test run matches a real payment hash, the real payment is silently dropped with no error surfaced to the caller (PITFALLS Pitfall #4). Enforcement: the test path must not call `recordPayment` from `lib/payments/x402/payment-gate.ts`. A Vitest spy on `recordPayment` in the test_workflow execution PR must assert zero calls across all test execution scenarios.

**Constraint 2: Separate endpoint only - zero diffs to `app/api/mcp/workflows/[slug]/call/route.ts` (TESTWF-02).**

Adding a `testMode: true` flag to the production call route creates a payment-gate bypass: any caller can include `testMode` in the POST body and execute paid workflows for free. The call route's existing `handlePaidWorkflow` / `gatePayment` functions check whether the request carries a valid x402 or MPP payment proof before executing. If `testMode` is parsed from the request body before that check, the gate is bypassed for any caller who knows to include the flag - there is no server-side enforcement restricting which callers can set it (PITFALLS Pitfall #5, Pitfall #9). The call route MUST have zero modifications in the future test_workflow PR. Enforcement: the test_workflow execution PR description must include `git diff --stat app/api/mcp/workflows/[slug]/call/route.ts` showing zero lines changed on that file.

**Constraint 3: Synthetic tx hashes use non-hex-prefix format `test-<uuid>`.**

A prefix such as `0xtest_<uuid>` is structurally a valid hex string header and could theoretically collide with or be confused for a real Ethereum tx hash. The `test-<uuid>` format starts with the literal ASCII character `t`, which is not a valid hex character after a `0x` prefix - collision with the format `0x[0-9a-fA-F]{64}` is impossible by character set. This also makes synthetic hashes trivially detectable in any database query (`WHERE payment_hash NOT LIKE 'test-%'` cleanly excludes them), enabling easy future cleanup migrations. Enforcement: a Vitest test asserts `synthHash.startsWith("test-") && !synthHash.startsWith("0x")` for every hash produced by the test runner.

**Constraint 4: pinData storage MUST specify TTL and row cap (see §5).**

Unbounded pin data growth is a documented anti-pattern (PITFALLS Pitfall #14). Without a time-based TTL, abandoned pin entries from one-off agent test sessions accumulate indefinitely. Without a per-org row cap, a misbehaving agent can call `prepare_test_pin_data` in a loop and exhaust table storage. The storage layer must include both. Enforcement: the `workflow_test_pins` migration in the future implementation PR must include both an `expires_at` index (for the TTL cleanup job) AND a per-org row-count guard (application-layer CHECK or equivalent). A PR that adds the table without both mechanisms must be rejected at review.

---

## 5. pinData Storage

The recommended storage model is a new `workflow_test_pins` Postgres table. Proposed schema:

```sql
CREATE TABLE workflow_test_pins (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT REFERENCES organizations(id),
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,            -- node within the workflow this pin targets
  pin_data        JSONB NOT NULL,           -- the pinned input value for this node
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,     -- = created_at + 24h
  UNIQUE (workflow_id, user_id, node_id)    -- one pin per (workflow, user, node)
);
CREATE INDEX workflow_test_pins_expires_at_idx ON workflow_test_pins (expires_at);
CREATE INDEX workflow_test_pins_org_idx ON workflow_test_pins (organization_id);
```

**TTL: 24 hours.** This is long enough for an agent to iterate through 10-20 test runs in a single work session while short enough that abandoned pins are evicted before they accumulate across sessions. A pin from a session last week is unlikely to represent useful state for a session today. Implementation: a nightly cleanup job deletes rows WHERE `expires_at < NOW()`. The TTL is refreshed to NOW() + 24h on every UPDATE, so a frequently-used pin stays alive as long as it is being actively iterated. Alternative considered: PostgreSQL `pg_cron` extension. Rejected because it adds operational complexity (extension must be enabled per environment) for a benefit that is only marginally better than the nightly job approach; the nightly job is already a pattern used elsewhere in the codebase.

**Row cap: 1000 rows per organization.** This bounds worst-case storage to approximately 10MB per org assuming 10KB average pin payload - well within safe bounds for a per-org ephemeral table. Enforcement: application-layer count check before INSERT; over-cap inserts return HTTP 429 with `Retry-After: 86400` (24 hours, after which TTL expiry will free rows). Rejected alternatives: hard CHECK constraint (rejected - Postgres CHECK constraints cannot reference aggregate counts across rows; a trigger-based approach is possible but adds migration complexity without meaningful benefit over the application-layer guard).

**Eviction policy.** Default eviction is TTL-based via nightly cron. The nightly job issues a single `DELETE FROM workflow_test_pins WHERE expires_at < NOW()`. This is a bulk delete against the `expires_at` index, which makes it efficient even at table sizes of hundreds of thousands of rows. Rejected alternatives: LRU eviction (rejected - requires an access-tracking `last_accessed_at` column with writes on every read, adding write amplification to what should be a read-heavy table); Redis (rejected - adds an infrastructure dependency purely for ephemeral pin storage; Postgres TTL via an indexed column is sufficient and eliminates the need for cache invalidation logic).

**Open question deferred to implementation: per-workflow vs per-(workflow, user) keying.** The current proposal keys pins per-(workflow, user, node) so that two agents iterating on the same listed workflow do not clobber each other's test pins. If Alice's agent sets a pin for node `web3-read-1` with a specific Aave LTV value and Bob's agent is testing the same workflow, Bob's test should not interfere with Alice's pin. The UNIQUE constraint on `(workflow_id, user_id, node_id)` implements this. Revisit if usage data suggests per-workflow keying is more ergonomic for the common single-user case.

---

## 6. `eth_call` vs Pure Mock

This question is intentionally NOT locked in this design doc. The final decision is deferred to the implementation PR after observing realistic agent usage patterns. Both options are documented below with their tradeoffs.

**Option A - Pure mock (no RPC at any boundary):**

Every on-chain read in the workflow graph must be satisfied by caller-supplied pin data. If a node has no pin entry in `pinData`, the test run fails immediately with `error: "missing-pin-data"` for that node.

Pros: Zero network dependency. Fully deterministic - identical pin data produces identical output on every run. No risk of test latency spikes from a slow RPC provider. The test runner has no external failure modes.

Cons: The caller must explicitly pin every on-chain read. For a workflow with 5 read-contract nodes querying live state (Aave V3 supply rates, Uniswap V3 pool prices, Chainlink oracle answers), the caller must manually construct realistic-looking values for each node. This burden falls on the agent and requires the agent to have domain knowledge about what realistic chain state looks like.

**Option B - `eth_call` for read-contract by default; pin data overrides:**

When the caller does not supply a pin for a given read-contract node, the test runner performs a real `eth_call` using the existing `lib/rpc/` client to fetch live chain state. When a pin is supplied, the pin value overrides the RPC result.

Pros: Default behavior matches "dry-run with real chain state" - the most common test scenario for an agent iterating on workflow logic. The caller only needs to pin when testing a specific hypothetical value (e.g. "what does my workflow do if Aave LTV is 90%?"). The test result closely matches what a real production execution would produce.

Cons: Network dependency on the RPC provider. Latency is bounded by `eth_call` latency, typically 50-200ms per call; a workflow with 5 read-contract nodes adds up to 1 second of RPC time. Test executions can fail if the RPC provider is degraded - though this failure mode matches production, it makes the test runner less reliable than pure mock.

**Hybrid (recommended default):** Option B as the default when `executionMode: "eth-call-fallback"` is set (or omitted, since this is the default). When the caller supplies a `pinData[nodeId]` entry for a given node, that entry overrides the RPC fallback for that node. When the caller sets `executionMode: "mock-only"`, all read-contract nodes MUST be pinned or the run fails with `error: "missing-pin-data"`. This gives callers the speed and determinism of pure mock when they want it (explicitly requesting `mock-only`) and the convenience of real chain reads for rapid iteration when they want that (the default).

**Decision:** Defer to implementation PR. This design doc commits to the hybrid contract shape (the `executionMode` enum in the API contract at §3); the default value may be adjusted when usage patterns are observable.

---

## 7. Paid Workflow Behavior in Test Mode

**No payment gate.** Test mode does NOT emit the `PAYMENT-REQUIRED` 402 challenge response. The separate endpoint at `/api/mcp/workflows/[slug]/test` has no x402 or MPP middleware attached. This is by design: the entire purpose of test mode is gas-free iteration, and requiring payment to test would defeat that purpose. The separate endpoint achieves this cleanly without any conditional logic in the production call route (per Constraint 2 in §4).

**No revenue accrual.** Per Constraint 1 (§4), zero writes to `workflow_payments` occur during any test_workflow call. Creator earnings dashboards are not affected by test calls in any way. Test executions do not appear in the creator's earnings report, do not count toward usage analytics for the listing, and do not affect the `billable` flag on any real `workflow_executions` row (because test executions do not write to `workflow_executions` at all - see §9, step 8).

**Rate limiting.** The default rate limit is 50 test calls per organization per day. This limit is configurable per org via the admin panel in a future iteration. The rationale is RPC cost containment: in `eth-call-fallback` mode, each test call may issue multiple `eth_call` RPC requests to live nodes. Unlimited test calls would amplify RPC provider costs beyond what can be absorbed at platform scale. Enforcement: a counter in Redis keyed by `(orgId, YYYY-MM-DD UTC)` tracks daily call count; when the counter exceeds the limit, the test endpoint returns HTTP 429 with `Retry-After: <seconds-until-midnight-UTC>` so the caller knows exactly when the window resets.

---

## 8. Mocking Boundary

The mock boundary is at the PLUGIN-STEP boundary - not the Workflow DevKit boundary.

Workflow DevKit (`@vercel/workflow`) executes the workflow function as a coherent unit. Mocking at the DevKit boundary (injecting an entirely different execution engine for test mode) would require duplicating substantial orchestration logic - the topology walk, the foreach expansion, the condition branching, the error handling. This duplication creates a maintenance burden: every change to the production executor would need to be mirrored in the test executor, and divergence between the two would silently produce test results that do not match production behavior. Instead, the test runner intercepts at the individual plugin step boundary. Each plugin step handler receives a `_context.testMode: boolean` flag via the step input's existing `_context` field (extending `StepInput._context`). The step handler itself decides what to mock based on its action type.

Per-plugin step behavior in test mode is defined as follows:

- **web3 write actions** (`write-contract`, `transfer-funds`, `swap`, and other state-mutating steps): return `{ success: true, txHash: "test-<uuid>", mockedAt: ISO8601_string }` instead of submitting a real transaction. No RPC call is made. No gas is spent. The synthetic `txHash` format follows Constraint 3 (§4).
- **web3 read-contract**: default to real `eth_call` matching the hybrid default in §6; use the caller's `pinData` override when `pinData[nodeId]` is supplied for this node. When `executionMode: "mock-only"`, the step must return pin data if present or fail with `error: "missing-pin-data"` if not.
- **Condition nodes, transformation nodes, off-chain plugins** (sendgrid, discord, webhook): execute for real. These have no on-chain side effects; their behavior is deterministic given their inputs; and running them against real conditions tests the actual branching logic of the workflow.
- **System action HTTP Request**: execute for real by default. Pin override is available for cases where the caller wants to test downstream behavior with a specific HTTP response shape without making the real HTTP call.
- **System action Database Query**: execute for real (read-only DB queries are safe in test mode). Write-query gating (preventing test mode from mutating the caller's database via a DB Query step) is a consideration for the implementation PR.

The `testMode` flag travels via `StepInput._context.testMode`. Plugins that need to mock check this flag at the top of their step handler before dispatching to the real execution logic. Plugins that have no on-chain side effects and do not need to mock (sendgrid, discord, webhook, condition, transform) ignore the flag entirely and execute normally.

---

## 9. Test Execution Flow

1. Caller invokes `POST /api/mcp/workflows/[slug]/test` with `{ workflowId, pinData, executionMode? }`.
2. Route authenticates via the existing `getDualAuthContext` pattern (same as the `/validate` route added in Phase 48) - accepts both signed-JWT session tokens and `kh_*` API keys.
3. Route checks the rate limit (50 test calls per org per day by default, per §7); returns HTTP 429 with `Retry-After` header if the limit is exceeded.
4. Route fetches the workflow via `getWorkflowAccess` for org-gating. An agent cannot test another organization's workflow - the same ownership check applied to `call_workflow` applies here.
5. Route enqueues a test execution via a NEW code path that does NOT call `prepareExecution` from the production call route. Calling `prepareExecution` would write a real `workflow_executions` row, which would appear in the user's execution history, trigger the `billable` accounting logic, and potentially interact with downstream `workflow_payments` inserts (PITFALLS Pitfall #4). The test path bypasses `prepareExecution` entirely.
6. Test runner instantiates each node's plugin step with `_context.testMode = true` and `_context.pinData = pinData[nodeId]` for any nodes whose IDs appear in the caller's `pinData` map.
7. Test runner walks the workflow graph using the same topology traversal logic as the production executor but in a separate code path - it does not call `start()` from `@vercel/workflow` or any Workflow DevKit API that creates real execution records.
8. Per-node results accumulate in memory. Zero writes occur to `workflow_executions`, `workflow_execution_logs`, `workflow_payments`, or any other production table. Test execution state is transient.
9. Synthetic execution ID is generated as `test-<uuid>` per Constraint 3 (§4).
10. Response is returned synchronously. Test runs are bounded by a hard 5-minute timeout per call; if the timeout is exceeded, partial results are returned with `status: "failed"` and an `error` field indicating which node timed out.

The 5-minute hard cap per call is consistent with n8n's test execution timeout. It is long enough to validate complex multi-node workflows that include multiple `eth_call` fallback reads against live nodes. It is short enough that an abusive agent (or an accidentally infinite workflow graph) cannot tie up a server process indefinitely. The cap is per-call, not per-org - a single long-running test does not consume other orgs' test capacity.

---

## 10. Implementation Phases (Future Work)

**Phase A - Mock-only baseline (lands first).** The minimum viable execution: every read-contract node MUST be pinned (no `eth_call` fallback). The runner walks the workflow graph, dispatches to each plugin step with `_context.testMode = true`, accumulates results in memory, and returns the full per-node result set. Storage for this phase uses a transient in-memory result map keyed by the synthetic `executionId`. No `workflow_test_pins` table is created in this phase - `pinData` is passed inline in the request body and is not persisted. This phase proves the test path is fully isolated from the production execution path and satisfies Constraints 1, 2, and 3 (§4) before any persistence complexity is added.

**Phase B - `eth_call` integration (default behavior in §6).** Adds the `executionMode: "eth-call-fallback"` default behavior. Plugin steps that perform on-chain reads first check `_context.pinData[nodeId]`; on a cache miss, they issue a real `eth_call` using the existing `lib/rpc/` client with the chain ID from the node's configuration. Acceptance criterion: a test run against a workflow with 5 read-contract nodes querying Aave V3 Pool state on mainnet produces realistic state values without any pin data supplied, and completes within the 5-minute timeout.

**Phase C - `workflow_test_pins` table (persistence).** Adds the schema migration from §5: the `workflow_test_pins` table with the `expires_at` index, the `(workflow_id, user_id, node_id)` UNIQUE constraint, the per-org row cap enforcement in the application layer, and the nightly cleanup job. Also adds management API endpoints: `POST /api/workflows/[id]/test-pins` (create or update a pin), `GET /api/workflows/[id]/test-pins` (list all pins for the workflow), and `DELETE /api/workflows/[id]/test-pins/[nodeId]` (remove a specific pin). Adds the nightly cron job that deletes expired rows. Acceptance criterion: a saved pin remains queryable across sessions for 24 hours; an org that has reached the 1000-row cap receives HTTP 429 on further pin creation attempts.

Each phase ships as a separate PR. Each PR re-confirms the four Hard Constraints in §4 still hold: zero diffs to the call route, zero `workflow_payments` writes, `test-<uuid>` hash format, and TTL + row cap in place.

---

## 11. Approval Log

Per TESTWF-04, this design doc is the merge gate for any test_workflow execution code. No execution implementation PR may merge until the user records an APPROVED decision in this table.

| Reviewer | Date | Decision | Notes |
|----------|------|----------|-------|
|          |      |          |       |

To approve: replace the empty row with your name, today's date in ISO 8601 (YYYY-MM-DD), `APPROVED` in the Decision column, and any caveats or scope notes. To request changes: use `CHANGES-REQUESTED` and list the changes in Notes. Approval is per-revision - material changes to §4 (Hard Constraints), §5 (pinData Storage), or §6 (eth_call default) require a new row.

---

*Design doc for v1.12 / KEEP-436 / Phase 49. Approval gate per TESTWF-04. See §4 for hard constraints; §11 for approval workflow.*
