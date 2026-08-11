## Summary

Phase 50 closes the METATOOL block of the v1.12 milestone (KEEP-436). The four METATOOL requirements are addressed in a single PR: `get_execution_status` and `get_execution_logs` are removed and replaced by a unified `get_execution(executionId, includeData?, nodeIds?, truncateData?)` tool (METATOOL-01, METATOOL-02); `get_template` and `search_plugins` are marked deprecated with a concrete v1.13 removal version committed inline (METATOOL-03); and the broader `get_resource` / `search_resources` consolidation is explicitly rejected with rationale documented here (METATOOL-04). The MCP server version is bumped from `1.1.0` to `1.2.0` across all three string literals (`lib/mcp/server.ts`, `app/mcp/route.ts` anon-init handler, `app/mcp/route.ts` GET ping body) to signal the breaking change to clients that cache the tool list.

## Merger Rationale (METATOOL-01, METATOOL-02)

`get_execution_status` (registered at `lib/mcp/tools.ts:449`) and `get_execution_logs` (registered at `lib/mcp/tools.ts:476`) were two separate tools that an agent had to call in sequence to get a complete picture of a workflow execution. This mirrors the pattern n8n's built-in MCP server (v2.13+) corrected with a single `get_execution` tool — when status and logs share the same resource identifier (`executionId`), splitting them into two tools forces an unnecessary round-trip and inflates agent tool-call overhead.

The unified `get_execution` tool folds the Phase 46 partial-data params verbatim: `includeData` (default `true`, preserving the backward-compat contract for agents that expect the full payload), `nodeIds` (per-node log filter), and `truncateData` (byte cap with truncated marker). The merge is at the MCP tool layer only — the underlying route (`/api/workflows/executions/[executionId]/logs` from Phase 46) is unchanged. Both old tools are REMOVED in this same PR with no deprecated-alias coexist state, following the binary-decision rule: a half-removal (keeping `get_execution_status` as an alias pointing to `get_execution`) would leave agents with a stale cached tool list that still calls the deprecated name and receives correct data, masking the breaking change from version consumers.

## Deprecation Schedule (METATOOL-03)

Two tools are marked deprecated in this PR as aliases pointing to their canonical replacements:

- `get_template` (formerly `lib/mcp/tools.ts:748`) — deprecated alias pointing to `get_workflow`. Description now prefixed with `[DEPRECATED — will be removed in v1.13. Use get_workflow instead.]`
- `search_plugins` (formerly `lib/mcp/tools.ts:614`) — deprecated alias pointing to `list_action_schemas`. Description now prefixed with `[DEPRECATED — will be removed in v1.13. Use list_action_schemas instead.]`

Both aliases remain functionally identical to their canonical targets in this PR (no behavior change). They will be removed in v1.13. The removal version is committed as a string literal in both description prefixes — not a comment or a doc note — so any agent that reads the tool description before calling it sees the concrete deadline.

## Rejection Rationale (METATOOL-04)

Two broader consolidation proposals were evaluated and rejected. The rejections are recorded here permanently so future planners do not re-litigate them without new evidence.

`get_resource(type, id, mode)` consolidation REJECTED: semantic mismatch across data shapes. Workflow vs template vs plugin have different identity surfaces (id vs slug vs name). Forcing a single `id` param plus `type` discriminant loses type safety and adds a runtime switch with no real ergonomic win.

`search_resources(type, query, ...)` consolidation REJECTED: search filter shapes differ across resource types. Workflow search filters on `isListed`/`category`/`chain`. Plugin search filters on action category and integration name. Template search filters on tags. Collapsing forces unionized filter args, which is worse than three distinct tools.

These rejections are binary and absolute, not "revisit later" deferrals. The deferred entry `METATOOL-FUTURE-01` in REQUIREMENTS.md is reserved only for re-evaluation if the MCP tool count crosses ~30 and context bloat becomes measurable.

## Post-Deploy Discovery Smoke (DISCOVERY-01)

- [ ] At least one listed workflow appears on agentcash
- [ ] At least one listed workflow appears on x402scan
- [ ] At least one listed workflow appears on mppscan
- [ ] At least one listed workflow appears on CDP Bazaar (agentic.market)
- [ ] extensions.bazaar.schema parses byte-identically vs pre-deploy snapshot
- [ ] Canonical PAYMENT-REQUIRED header parses byte-identically vs pre-deploy snapshot

All six gates must be GREEN before this PR is marked ready-to-merge. Record results inline in the PR review thread; no separate file required.

## Milestone Closure (CLOSE-01)

### Shipped (34 REQ-IDs)

| REQ-ID | Phase | Brief outcome |
|--------|-------|---------------|
| LOGS-01 | Phase 46 | `get_execution_logs` `includeData` param added (default `true` for backward compat) |
| LOGS-02 | Phase 46 | `get_execution_logs` `nodeIds` filter added for per-node log inclusion |
| LOGS-03 | Phase 46 | `get_execution_logs` `truncateData` byte cap added with `truncated: true` marker |
| TEST-03 | Phase 46 | `get_execution_logs` backward-compat fixture (no-params call returns identical shape) |
| CLOSE-02 | Phase 46 | MCP server version bumped from 1.0.0 to 1.1.0 |
| TRIG-01 | Phase 47 | `call_workflow_<slug>` emits `manual` discriminant input schema |
| TRIG-02 | Phase 47 | `call_workflow_<slug>` emits `schedule` discriminant input schema |
| TRIG-03 | Phase 47 | `call_workflow_<slug>` emits `webhook` discriminant input schema with `method`/`query`/`body`/`headers` |
| TRIG-04 | Phase 47 | `call_workflow_<slug>` emits `on-chain-event` discriminant input schema |
| TEST-02 | Phase 47 | Per-workflow registration smoke for `event`-trigger workflows |
| DOCS-02 | Phase 47 | `docs/ai-tools/mcp-trigger-inputs.md` caller-facing guide shipped |
| VALID-01 | Phase 48 | `validate_workflow` returns `{ valid, nodeCount, errors?, warnings? }` response shape |
| VALID-02 | Phase 48 | `validate_workflow` structural checks (edges, trigger config, expression syntax, bare-@ literals) |
| VALID-03 | Phase 48 | `validate_workflow` listing-eligibility checks (`inputSchema`, `outputMapping` node refs) |
| VALID-04 | Phase 48 | `validate_workflow` write-action consistency check against `workflowType` |
| VALID-05 | Phase 48 | `validate_workflow` chain ID resolution against `chains` Drizzle table |
| VALID-06 | Phase 48 | `validate_workflow` token address format check via `ethers.isAddress()` |
| VALID-07 | Phase 48 | `validate_workflow({ deepCheck: true })` ABI match via `resolveAbi`; warnings (not errors) for proxy contracts |
| VALID-08 | Phase 48 | `validate_workflow` and `deepCheck` added to `READ_TOOLS` in `lib/mcp/oauth-scopes.ts` |
| TEST-01 | Phase 48 | 21-workflow `validate_workflow` smoke fixture; zero false-positive errors |
| DOCS-01 | Phase 48 | `docs/ai-tools/mcp-validate-workflow.md` caller-facing guide shipped |
| TESTWF-01 | Phase 49 | Design doc at `specs/mcp-test-workflow.md` covering pinData, mocking boundary, TTL, synthetic tx hash |
| TESTWF-02 | Phase 49 | Design doc hard constraint: separate endpoint, zero diffs to existing call route |
| TESTWF-03 | Phase 49 | Design doc hard constraint: zero writes to `workflow_payments` during test mode |
| TESTWF-04 | Phase 49 | Design doc reviewed and approved by user; approval recorded inline |
| TESTWF-05 | Phase 49 | `prepare_test_pin_data({ workflowId })` MCP tool ships (introspection only) |
| TESTWF-06 | Phase 49 | `prepare_test_pin_data` added to `READ_TOOLS` in `lib/mcp/oauth-scopes.ts` |
| DOCS-03 | Phase 49 | `docs/ai-tools/mcp-test-workflow.md` caller-facing guide shipped |
| METATOOL-01 | Phase 50 | `get_execution` merger decision documented in this PR description |
| METATOOL-02 | Phase 50 | Old tools removed and new `get_execution` tool added in the same PR |
| METATOOL-03 | Phase 50 | `get_template` and `search_plugins` deprecated with v1.13 removal version committed inline |
| METATOOL-04 | Phase 50 | `get_resource` and `search_resources` consolidation rejected with rationale in this PR description |
| DISCOVERY-01 | Phase 50 | Post-deploy smoke checklist covering 4 scanners + 2 parse-byte-identical gates |
| CLOSE-01 | Phase 50 | KEEP-436 closed with this shipped/deferred breakdown |

### Deferred to v1.13+ (4 REQ-IDs)

| Future REQ-ID | Rationale |
|---------------|-----------|
| TESTWF-FUTURE-01 | `test_workflow` execution code — design doc approved (TESTWF-04 shipped); mock provider architecture + pinData eviction need v1.13+ research |
| VALID-FUTURE-01 | ABI bytecode verification depth beyond `deepCheck` — selector-aware introspection without proxy false-positives needs research |
| VALID-FUTURE-02 | Token decimals + `symbol()` resolution via `eth_call` — latency budget + failure modes need research |
| METATOOL-FUTURE-01 | `get_resource` consolidation — REJECTED in this PR; reserved for re-evaluation only if MCP tool count >~30 |

## Closes

Closes KEEP-436
