# Task: Direct Execution API (F-008)

Status: SHIPPED
Priority: 7 (month 1-3)
Effort: M (3 weeks)
Depends on: F-048 (SHIPPED)

## Objective

REST API endpoints that enable AI agents to execute on-chain actions directly -- without creating persistent workflows. These endpoints are the backend that the KeeperHub MCP server (separate repo) wraps as MCP tools.

5 endpoints:
- `POST /api/execute/transfer` -- Send ETH/tokens (202 async)
- `POST /api/execute/contract-call` -- Call any contract function; auto-routes read (200) vs write (202)
- `POST /api/execute/swap` -- DEX swap (placeholder, returns 501)
- `POST /api/execute/check-and-execute` -- Read on-chain state, evaluate condition, execute if met (202)
- `GET /api/execute/{executionId}/status` -- Poll execution status

Plus infrastructure:
- Rate limiting per API key (60 req/min, in-memory sliding window)
- Spending cap enforcement per organization (`organization_spend_caps` table)
- Audit logging to `direct_executions` table with input redaction

## Context

Workflow-based execution requires create workflow -> execute workflow. AI agents think in actions: "transfer funds", "call this contract." Direct execution removes the workflow overhead.

This unblocks: F-009 (AI Agent Wallet Guardian), F-010 (ERC-8004), F-011 (Agent Framework SDKs).

## What F-048 Already Shipped (reused, not rebuilt)

The v1.2 Protocol Registry milestone shipped these components that F-008 imports directly:

- **`keeperhub/lib/abi-cache.ts`** -- `resolveAbi({ contractAddress, network, abi? })` with 24h in-memory cache, proxy detection (EIP-1967/1822/2535), block explorer auto-fetch. Used for `contract-call` and `check-and-execute` ABI resolution.
- **`keeperhub/plugins/web3/steps/read-contract-core.ts`** -- `readContractCore()` for read-only contract calls and the "check" phase of check-and-execute.
- **`keeperhub/plugins/web3/steps/write-contract-core.ts`** -- `writeContractCore()` handles Para wallet, nonce management, gas strategy. Used for `contract-call` writes and check-and-execute execution.
- **`keeperhub/plugins/web3/steps/transfer-funds-core.ts`** -- `transferFundsCore()` for native ETH transfers. Extracted during F-008 prep work.
- **`keeperhub/plugins/web3/steps/transfer-token-core.ts`** -- `transferTokenCore()` for ERC-20 token transfers. Extracted during F-008 prep work.

## Acceptance Criteria

- [x] `POST /api/execute/transfer` accepts `{ recipientAddress, amount, tokenAddress?, tokenConfig?, network }`, returns `{ executionId, status }` with 202. Routes to `transferFundsCore()` (native) or `transferTokenCore()` (ERC-20) based on `tokenAddress`/`tokenConfig` presence.
- [x] `POST /api/execute/contract-call` accepts `{ contractAddress, abi?, functionName, functionArgs?, network, value?, gasLimitMultiplier? }`, returns `{ executionId, status }` (202 for writes) or `{ result }` (200 for reads). Auto-detects read vs write via ABI `stateMutability`. When `abi` omitted, uses `resolveAbi()`. Returns 400 if contract unverified and no ABI provided.
- [x] `POST /api/execute/swap` returns `{ error: "Swap execution is not yet implemented" }` with 501 status.
- [x] `POST /api/execute/check-and-execute` accepts `{ contractAddress, network, functionName, abi?, functionArgs?, condition: { operator, value }, action: { contractAddress, functionName, functionArgs?, abi?, gasLimitMultiplier? } }`. Returns 202 with `{ executionId, status }` if condition met, or 200 with `{ executed: false, conditionResult }` if not met. Supports operators: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`.
- [x] `GET /api/execute/{executionId}/status` returns `{ executionId, type, status, result?, error?, transactionHash?, transactionLink?, createdAt, completedAt? }`. Returns 404 if not found. Scoped to the authenticated organization.
- [x] All endpoints require API key auth via `Authorization: Bearer kh_xxxxx` header. Uses `organizationApiKeys` table in `keeperhub/db/schema-extensions.ts`. SHA-256 hashed lookup, validates non-revoked and non-expired.
- [x] Rate limiting: max 60 requests/minute per API key (return 429 with `Retry-After` header). In-memory sliding window per process.
- [x] Spending cap: orgs can set max daily spend via `organization_spend_caps` table (`dailyCapWei`). Reject with 403 if exceeded. No cap row = unlimited.
- [x] All executions logged to `direct_executions` table with: id, organizationId, apiKeyId, type, input (redacted via `redactInput()`), output, status, transactionHash, network, gasUsedWei, error, createdAt, completedAt.
- [x] Input validation with clear error messages via dedicated `validate.ts` module (invalid address format, unsupported network, missing required fields, etc).
- [x] Integration tests: 23 tests covering all endpoints, auth paths, rate limiting, validation, spending caps, success/failure flows.
- [x] `pnpm check` and `pnpm type-check` pass with zero errors.

## Technical Approach

### Reuse existing core logic (DO NOT DUPLICATE)

| Endpoint | Core function | File |
|---|---|---|
| `/execute/transfer` (native) | `transferFundsCore()` | `keeperhub/plugins/web3/steps/transfer-funds-core.ts` |
| `/execute/transfer` (ERC-20) | `transferTokenCore()` | `keeperhub/plugins/web3/steps/transfer-token-core.ts` |
| `/execute/contract-call` (write) | `writeContractCore()` | `keeperhub/plugins/web3/steps/write-contract-core.ts` |
| `/execute/contract-call` (read) | `readContractCore()` | `keeperhub/plugins/web3/steps/read-contract-core.ts` |
| `/execute/check-and-execute` (check) | `readContractCore()` | `keeperhub/plugins/web3/steps/read-contract-core.ts` |
| `/execute/check-and-execute` (execute) | `writeContractCore()` | `keeperhub/plugins/web3/steps/write-contract-core.ts` |
| ABI resolution | `resolveAbi()` | `keeperhub/lib/abi-cache.ts` |

### File structure

```
keeperhub/api/execute/
  transfer/route.ts
  contract-call/route.ts
  swap/route.ts
  check-and-execute/route.ts
  [executionId]/status/route.ts
  _lib/
    auth.ts              -- API key validation (organizationApiKeys table, SHA-256 hash)
    condition.ts         -- evaluateCondition() for check-and-execute (BigInt + string comparison)
    execution-service.ts -- Shared orchestration (create, markRunning, complete, fail)
    rate-limit.ts        -- In-memory sliding window (60 req/min per key)
    spending-cap.ts      -- Daily spend tracking (organizationSpendCaps table, UTC day boundary)
    types.ts             -- Request/response types and redactInput()
    validate.ts          -- Input validation for all endpoints
```

Thin wrappers in `app/api/execute/` re-exporting from `keeperhub/api/execute/` (same pattern as `app/api/protocols/route.ts`).

### Database

Tables added to `keeperhub/db/schema-extensions.ts`:

```typescript
export const directExecutions = pgTable("direct_executions", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  apiKeyId: text("api_key_id").notNull(),
  type: text("type").notNull(), // "transfer" | "contract-call" | "check-and-execute"
  input: jsonb("input"),        // redacted copy (no private keys, truncated ABIs)
  output: jsonb("output"),
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  transactionHash: text("transaction_hash"),
  network: text("network").notNull(),
  gasUsedWei: text("gas_used_wei"), // for spending cap calculations
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const organizationSpendCaps = pgTable("organization_spend_caps", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  organizationId: text("organization_id").notNull().unique().references(() => organization.id),
  dailyCapWei: text("daily_cap_wei").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

Migration: `drizzle/0022_daily_zuras.sql` (generated via `pnpm drizzle-kit generate`).

### Auth

Uses `organizationApiKeys` table (not the older `apiKeys` table). Keys prefixed `kh_`, SHA-256 hashed for storage, organization-scoped. Validates non-revoked and non-expired. Updates `lastUsedAt` on each successful auth (fire-and-forget).

### Rate limiting

In-memory Map, sliding window per API key. 60 requests per 60-second window. Returns 429 with `Retry-After` header. Note: each pod tracks independently, effective limit = 60 x num_replicas. Redis upgrade tracked for later.

### Spending cap

Separate `organization_spend_caps` table. If no row exists for an org, spending is unlimited. Sums `gasUsedWei` from completed executions within the current UTC day. MVP uses read-then-compare (race condition window exists; SELECT FOR UPDATE upgrade tracked for later).

### Execution flow

```
Request -> Auth (API key) -> Rate limit -> Validate input -> Check spending cap
  -> Create directExecution record (status: pending)
  -> Mark running
  -> Execute using core logic (Para wallet, nonce mgmt, gas strategy)
  -> On success: completeExecution() with txHash + output
  -> On failure: failExecution() with error message
  -> Return { executionId, status } with 202 (writes) or { result } with 200 (reads)
```

### Contract-call read vs write routing

The contract-call endpoint auto-detects read vs write operations:
1. Resolve ABI (from request or via `resolveAbi()`)
2. Find the target function in the ABI
3. Check `stateMutability`: if `view` or `pure` -> read path, otherwise -> write path
4. Read path: call `readContractCore()`, return 200 with result directly (no execution record)
5. Write path: create execution record, call `writeContractCore()`, return 202

### Check-and-execute condition evaluation

The `condition.ts` module evaluates conditions against contract read results:
- Supports 6 operators: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`
- Attempts BigInt comparison first, falls back to string comparison
- Extracts values from nested objects (handles `{ result: value }` shapes)
- Returns `ConditionResult` with `met`, `observedValue`, `targetValue`, `operator`

## Scope

**Built:**
- 4 action endpoints + status polling endpoint
- ABI resolution via existing `resolveAbi()` (no new ABI code)
- API key auth using `organizationApiKeys` table
- Rate limiting (in-memory sliding window, 60 req/min)
- Spending cap enforcement (`organization_spend_caps` table)
- `direct_executions` + `organization_spend_caps` DB tables + migration
- Input validation (dedicated module)
- Condition evaluation (dedicated module with BigInt support)
- Audit logging with input redaction
- 23 integration tests

**Skipped (intentional):**
- MCP server wrapper (separate repo)
- Spending cap configuration UI (manual DB config for now)
- API key management UI (separate concern)
- Per-execution billing / metering (F-012)
- WebSocket status updates (polling is fine)
- Swap implementation (placeholder only)
- Actual gas cost tracking (`gasUsedWei` hardcoded to "0" in MVP -- needs gas receipt parsing)
- Redis-backed rate limiting (in-memory is sufficient for single-pod)

## Files

**Implementation:**
- `keeperhub/api/execute/_lib/auth.ts` -- API key auth
- `keeperhub/api/execute/_lib/condition.ts` -- Condition evaluation
- `keeperhub/api/execute/_lib/execution-service.ts` -- Execution lifecycle management
- `keeperhub/api/execute/_lib/rate-limit.ts` -- Rate limiter
- `keeperhub/api/execute/_lib/spending-cap.ts` -- Spending cap enforcement
- `keeperhub/api/execute/_lib/types.ts` -- Types and input redaction
- `keeperhub/api/execute/_lib/validate.ts` -- Input validation
- `keeperhub/api/execute/transfer/route.ts` -- Transfer endpoint
- `keeperhub/api/execute/contract-call/route.ts` -- Contract call endpoint
- `keeperhub/api/execute/swap/route.ts` -- Swap placeholder
- `keeperhub/api/execute/check-and-execute/route.ts` -- Conditional execution
- `keeperhub/api/execute/[executionId]/status/route.ts` -- Status polling

**Thin wrappers (app router):**
- `app/api/execute/transfer/route.ts`
- `app/api/execute/contract-call/route.ts`
- `app/api/execute/swap/route.ts`
- `app/api/execute/check-and-execute/route.ts`
- `app/api/execute/[executionId]/status/route.ts`

**Schema + migration:**
- `keeperhub/db/schema-extensions.ts` -- `directExecutions` and `organizationSpendCaps` tables
- `drizzle/0022_daily_zuras.sql` -- Migration

**Core logic (reused from F-048):**
- `keeperhub/plugins/web3/steps/read-contract-core.ts`
- `keeperhub/plugins/web3/steps/write-contract-core.ts`
- `keeperhub/plugins/web3/steps/transfer-funds-core.ts`
- `keeperhub/plugins/web3/steps/transfer-token-core.ts`
- `keeperhub/lib/abi-cache.ts`

**Tests:**
- `tests/integration/direct-execution-api.test.ts` -- 23 integration tests

## Constraints

- All custom code in `keeperhub/` per fork policy
- Step files with `"use step"` cannot export functions -- use `-core.ts` pattern
- No Node.js-only SDKs in step files -- use `fetch()` directly
- Biome lint: block statements, cognitive complexity max 15, top-level regex
- Database migrations: `pnpm drizzle-kit generate`, never `db:push`
