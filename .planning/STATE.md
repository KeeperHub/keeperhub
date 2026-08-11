---
gsd_state_version: 1.0
milestone: v1.13
milestone_name: Scan-to-Automate Onboarding
status: executing
last_updated: "2026-06-30T09:34:22.619Z"
last_activity: 2026-06-30
progress:
  total_phases: 8
  completed_phases: 6
  total_plans: 34
  completed_plans: 33
  percent: 75
---

# Project State

## Project Reference

- **Core value:** Users can build and deploy Web3 automation workflows through a visual builder without writing code.
- **Current focus:** Phase 57 — apy-aware-stablecoin-yield-suggestions

## Current Position

Phase: 57 (apy-aware-stablecoin-yield-suggestions) — EXECUTING
Plan: 3 of 3
Status: Ready to execute
Last activity: 2026-06-30

## Performance Metrics

- Phases planned: 5 (51-55)
- Phases complete: 0
- Plans complete: 10/13 (51-01..51-06, 52-01, 52-02 done)
- Duration 51-01: 31 minutes
- Duration 51-02: ~20 minutes
- Duration 51-03: 27 minutes
- Duration 51-04: 7 minutes
- Duration 51-05: 10 minutes
- Duration 51-06: 7 minutes
- Duration 52-01: 10 minutes
- Duration 52-02: 4 minutes
- Duration 52-05: 12 minutes
- Duration 53-01: 5 minutes
- Duration 53-02: 8 minutes
- Duration 53-03: 5 minutes
- Duration 53-04: 7 minutes
- Duration 54-03: 4 minutes
- Duration 54-04: 25 minutes
- Duration 55-02: 8 minutes
- Duration 55-03: 5 minutes
- Duration 55-04: 6 minutes

## Accumulated Context

### Decisions (already locked, do NOT re-debate during planning)

- Detection is hybrid: KeeperHub registry + Multicall3 reads FIRST, Zerion REST API as breadth fallback. No new npm packages; one new env var `ZERION_API_KEY`.
- Prefill is DETERMINISTIC (parameterized workflow factory, ~6 shapes covering 4 categories + generic fallback). NO AI generation in v1.13.
- Stablecoin idle-yield is MONITOR/DISPLAY ONLY in v1.13 (read-only). Write auto-deposit path deferred.
- Anonymous funnel: scan + suggestions require zero signup; sign-in gates only run/save. All rate-limiting + scan cache is Postgres-backed (not in-memory) for multi-pod correctness.
- USD pricing: Chainlink feeds for majors + DefiLlama for the rest; stablecoins priced from Chainlink (never hardcoded $1.00) with depeg detection.
- New `lib/scan/` module inserted between existing RPC infra and existing canvas/auth rails; touches only three existing files (schema additive, layout one line, new migration).
- `pending_scan` HttpOnly cookie mirrors `pending_template` pattern exactly; `PendingScanRunner` mirrors `PendingTemplateRunner`.
- Zerion used as breadth fallback only — never replaces native adapters for Aave, Compound, Lido, Spark (those have native adapters with better fidelity).
- Phase 51 builds Aave V3 + Lido adapters first (highest-signal for suggestion quality); remaining adapters (Compound V3, Spark, Sky) land in Phase 52.
- Multicall3 batches all reads per chain into one `eth_call` (one round-trip per chain); `Promise.allSettled` across chains.
- Per-chain timeout: 4s. Scan cache TTL: 5 minutes in-process check; cron sweeper deletes rows older than 1 hour.
- Write-type prefills must use exact (non-MaxUint256) approval amounts; server validator blocks MaxUint256 in scan-generated workflows (PREFILL-07).
- ProtocolAdapter uses pure buildCalls/decode shape (no class instantiation); orchestrator owns the multicall batch (51-01).
- L2 Chainlink stablecoin feeds omitted from registry (multiple candidate addresses); DefiLlama fallback applies for all L2 stablecoin pricing (51-01).
- BigInt() constructor used in tests instead of n-suffix literals for ES2017 tsconfig compatibility (51-01).
- aggregate3 (not tryAggregate or aggregate) used for Multicall3 batching — per-call allowFailure is embedded in each call struct (51-03).
- AbortController races via Promise.race in scanWithTimeout; clearTimeout in finally ensures cleanup on both fast-resolve and abort paths (51-03).
- isDepegged uses inclusive >= 0.005 threshold; IEEE 754 means price exactly 1.005 evaluates as non-depegged — plan test cases use 1.005000001 to sidestep this (51-04).
- resolveUsdPrice opts.chainlinkResult pattern: orchestrator pre-fetches Chainlink via aggregate3 and passes decoded MulticallResult; no independent RPC from pricing layer (51-04).
- L2 wstETH: raw balance only — getStETHByWstETH not called on L2 bridges (A6 resolved, Phase 52 may add conversion) (51-06).
- Stablecoin adapter is pure over orchestrator-supplied token list; no direct DB query inside the adapter (51-06).
- decodeAaveV3Results does not check AAVE_V3_POOLS registry — decode is chainId-agnostic; registry used only in buildAaveV3Calls (51-05).
- resolveImplementationAddress takes provider directly (not chainId) for clean testability without getRpcProvider mock (51-05).
- EIP1967_IMPLEMENTATION_SLOT exported from proxy-detection.ts rather than re-implemented as a new literal (51-05).
- Wave 0 stubs required for type-check compliance: engine.ts / factory/index.ts / factory/validate.ts created as throw-stubs so pnpm type-check passes while RED tests land; Wave 2 replaces stubs with real implementations (52-01).
- clampHfThreshold: returns HF_DEFAULT (1.5) when currentHf > 1.5; Math.max(currentHf - 0.1, 1.3) otherwise; hard floor 1.3 never breached (52-02).
- hfThresholdRaw uses BigInt(Math.floor(threshold * 1e18)).toString() — safe for 1.3/1.5 because both are exactly representable IEEE 754 doubles at 1e18 scale (52-02).
- alert category built from supply-only Aave positions (healthFactor null, protocol !== lido); Lido null-HF positions route to claim only (52-02).
- suggestions? field is OPTIONAL on ScanResponse (type-only import from suggestions/types.ts) for backward compatibility with Phase 51 callers and cached rows pre-dating 52-05.
- buildSuggestions wrapped in inner try/catch in the route so any engine failure degrades to suggestions:[] rather than failing the 200 response (T-52-12, 52-05).
- Suggestions attached in the route (not inside scanAddress) — cached scan rows pre-dating 52-05 are unaffected; route computes fresh suggestions on each response.
- Token-first ordering: health badge tokens committed in 53-01 before any component references them, preventing token-audit failures during Wave 2 component commits (53-01).
- Local type aliases in E2E fixtures: mirrors ScanResponse shapes without importing from server-only lib/scan/types.ts; type-check passes via locally-defined structural equivalents (53-01).
- Kebab-case filenames used for scan components: biome useFilenamingConvention enforces kebab-case across all non-excluded linted dirs; category-badge.tsx, read-write-pill.tsx, suggestion-card.tsx, suggestion-card-skeleton.tsx (53-02).
- role=img on CategoryBadge span: biome useAriaPropsSupportedByRole requires aria-label on elements with a supporting role; role=img is semantically appropriate for a visual category indicator (53-02).
- Kebab-case filename suggestion-preview-drawer.tsx per 53-02 Biome naming convention; plan files_modified listed PascalCase but kebab is enforced (53-04).
- section element for canvas landmark instead of div role=region — biome useSemanticElements prefers HTML5 semantic elements (53-04).
- buildWorkflow wrapped in try/catch inside useMemo for graceful degradation if factory throws on invalid descriptors (53-04).
- Atom cleanup (setNodes([]), setEdges([]), setIsOwner(true)) runs in useEffect return; currentWorkflowIdAtom never set so WorkflowToolbar stays hidden and autosave never fires (53-04).
- Throw-stubs use non-async functions to satisfy biome useAwait rule; Next.js route handlers support synchronous handlers (54-01).
- Idempotency key uses descriptor.id (SuggestionDescriptor.id), NOT a non-existent suggestionSlug field — distinct ids produce distinct sessionStorage slots (54-01).
- scan-callback-url.test.ts added as 4th RED unit test per objective spec; covers FUNNEL-02 address preservation and intent.id idempotency key distinction (54-01).
- resolveCallbackUrl allowlist guard: starts with single "/", not "//", no "://", no backslash — reject-by-default is correct for open-redirect mitigation (54-02).
- Biome import sort places @/lib/auth/ before @/lib/auth- (sorts "/" before "-" in path segments); resolveCallbackUrl import placed first in the @/lib/auth* block (54-02).
- Pre-existing biome issues in dialog.tsx (noUnusedVariables:router, useExhaustiveDependencies, noNestedTernary, suppressions/unused x3) deferred per SCOPE BOUNDARY rule — none introduced by 54-02 (54-02).
- persistSuggestion uses factory re-derivation (buildWorkflow) as trust boundary; cookie confirmInputs never sent raw to create API (T-54-20) (54-03).
- vi.hoisted required for Vitest mock variables referenced in vi.mock factories — TDZ error occurs when const declarations appear after the (hoisted) vi.mock call that references them (54-03).
- organizationId sourced solely from getDualAuthContext in wallet-check endpoint; no org-identifying param accepted from request (T-54-31 cross-org probing guard) (54-04).
- TEST-03 E2E uses ctx.route(glob) instead of page.route(RegExp); context-level glob routes are registered before the first network request, eliminating setup race (54-04).
- TEST-03 signIn() utility replaced with inline dialog interaction: signIn() navigated to "/" which raced with PendingScanRunner navigating to /workflows/{id} before org-switcher appeared (54-04).
- MFA-enrollment skip guard added to TEST-03: page.url().includes('/enroll-mfa') triggers test.skip with documented reason (54-04).
- scan-cache-sweeper uses authenticateInternalService HMAC (no NODE_ENV bypass); agentic-wallet-sweeper Bearer pattern explicitly not mirrored for this endpoint (55-02).
- scan-cache-sweeper CronJob schedule */30 * * * *; cluster helm apply is operator-gated and not performed in this phase (55-02).
- Console-mode metrics only in v1.13; metricsCollector+scanTimer declared before try in route; SCAN_ZERION_CALLS_TOTAL stays 0 — TODO comment marks future increment site at maybeZerionFallback (55-04).
- ApyContext defined as interface with getBestYield(symbol, chainId): ApyEntry | null — not Map<string, ApyEntry> — keeps engine pure sync and easily mockable (57-01).
- DEFILLAMA_YIELDS_CHAIN_SLUGS separate from DEFILLAMA_CHAIN_SLUGS: yields API uses title-case ("OP Mainnet" not "Optimism") — separate map required (57-01).
- Wave 0 throw-stub pattern applied to 57-01: all 4 defillama-yields.ts functions throw "not implemented: 57-02"; type-check passes; 20 RED tests land; Wave 2 (57-02) replaces stubs with real implementations (57-01).

### Roadmap Evolution

- Phase 56 added (2026-06-29): Spark + Sky scan adapters — completes the deferred Spark/Sky portions of SCAN-03 (Aave V3 was the only adapter shipped in Phase 51). Adds SCAN-15 (scan-scoped DAI exclusion) and PREFILL-08 (factory protocol-aware pool selection). Compound V3 explicitly deferred. Design spec: `specs/scan-spark-sky-adapters.md`. Locked scope decisions: Spark reuses Aave decode; Sky = sUSDS only (sDAI dropped); price Sky via maxWithdraw → USDS → DefiLlama so the suggestion survives the dust filter; DAI excluded scan-scoped only (global registry untouched); read-only.

### Todos

- Run `/gsd:plan-phase 56` to plan Phase 56: Spark + Sky Scan Adapters.

### Blockers

- None.

## Session Continuity

- Roadmap file: `.planning/ROADMAP.md`
- Requirements file: `.planning/REQUIREMENTS.md`
- Last shipped milestone: v1.12 (MCP n8n Pattern Borrows, phases 46-50, shipped 2026-05-18, never formalized in GSD)
- Last completed: 57-02 (APY-aware yield suggestions GREEN wave — DefiLlama yields client + APY-aware engine copy; all 20 RED tests from 57-01 now GREEN) — 2026-06-30
- Stopped at: 57-02 complete; 57-03 (factory wave) pending
- Next command: execute 57-03-PLAN.md

## Deferred Items

Items carried forward from v1.11 close and v1.12 (informal):

| Category | Item | Status |
|----------|------|--------|
| feature | MARKET-FUTURE-01..04 (earnings sort, time-window filters, materialized stats, per-row vote) | deferred to v1.11.x or later |
| feature | HUB-FUTURE-02 (per-tag OG image generation) | deferred |
| testing | Cross-browser CI runs (Firefox + WebKit) | deferred — Chromium-only by default |
| upstream | Next.js bfcache hydration race upstream issue/PR | deferred per Phase 45 ADR |
| v1.13 future | AI-generated prefill path for exotic/long-tail positions | deferred — no-AI-in-prefill decision in v1.13 |
| v1.13 future | Stablecoin idle-yield WRITE path (auto-deposit via Turnkey) | deferred |
| v1.13 future | Category-4 auto-claim WRITE workflows | deferred |
| v1.13 future | Additional protocol adapters (Morpho, Curve, Pendle, Yearn, Aerodrome) | deferred |
| v1.13 future | Shareable scan-result URLs (with privacy consent) | deferred |
| scanner-infra | `pnpm check` Biome config error (`noIncrementDecrement` unknown key in biome.jsonc:58) — pre-existing, unrelated to plan 51-05 | deferred |
| Phase 54-auth-round-trip-persistence P01 | 28 minutes | 3 tasks | 9 files |
| Phase 54-auth-round-trip-persistence P02 | 6 minutes | 2 tasks | 4 files |
| Phase 54-auth-round-trip-persistence P03 | 4 minutes | 2 tasks | 4 files |
| Phase 55-polish-hardening P02 | 8 minutes | 2 tasks | 3 files |
| Phase 55-polish-hardening P04 | 6 minutes | 2 tasks | 3 files |
| testing | scan-route-suggestions.test.ts 7 tests failing — NEXT_PUBLIC_SCAN_ENABLED not set in beforeEach; pre-existing since 55-03 flag gate (commit a51139f1); fix: add `process.env.NEXT_PUBLIC_SCAN_ENABLED = "true"` in beforeEach | deferred |
| Phase 56-spark-sky-scan-adapters P05 | 90 | 2 tasks | 3 files |
| Phase 57-apy-aware-stablecoin-yield-suggestions P01 | 10 | 3 tasks | 5 files |
| Phase 57 P02 | 7 | 2 tasks | 3 files |
