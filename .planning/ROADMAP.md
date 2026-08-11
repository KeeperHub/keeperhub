# Roadmap: KeeperHub

## Milestones

- Complete **v1.0 Service Extraction** - Phases 1-4 (shipped 2026-02-12)
- Complete **v1.1 OG Image Generation** - Phase 5 (shipped 2026-02-12)
- Complete **v1.2 Protocol Registry** - Phases 6-9 (shipped 2026-02-20)
- Complete **v1.3 Direct Execution API** - Phases 10-12 (shipped 2026-02-20)
- Complete **v1.4 Agent Team** - Phases 13-18 (shipped 2026-03-01)
- Complete **v1.5 KeeperHub CLI** - Phases 19-24 (shipped 2026-03-14)
- Complete **v1.7 Agent-Callable Workflows** - Phases 25-31 (shipped 2026-04-21)
- Complete **v1.8 Agentic Wallet for KeeperHub** - Phases 32-36 (shipped 2026-04-21) — archived in [milestones/v1.8-ROADMAP.md](milestones/v1.8-ROADMAP.md)
- Complete **v1.9 Code Sandbox Hardening (Minimal)** - Phases 37-39 (shipped 2026-04-23) — archived in [milestones/v1.9-ROADMAP.md](milestones/v1.9-ROADMAP.md)
- Complete **v1.10 Agentic Wallet & Marketplace Plumbing** - Phases 40-41 (shipped 2026-04-29) — archived in [milestones/v1.10-ROADMAP.md](milestones/v1.10-ROADMAP.md)
- Complete **v1.11 Marketplace Discovery & Hub UX** - Phases 42-45 (shipped 2026-05-01) — archived in [milestones/v1.11-ROADMAP.md](milestones/v1.11-ROADMAP.md)
- Complete **v1.12 MCP n8n Pattern Borrows** - Phase 46-50 (shipped 2026-05-18, not formalized in GSD)

---

## Current Milestone: v1.13 Scan-to-Automate Onboarding

**Goal:** Turn a cold Ethereum address into a personalized set of KeeperHub automation suggestions — paste an address at `/scan`, scan DeFi positions + stablecoins across all supported chains, see a ranked list of named automation suggestions, click one to preview a prefilled workflow on the existing canvas, and run it or save it on a schedule (sign-in gated only at run/save).

## Phases

- [x] **Phase 51: Scanner Infrastructure** - Multi-protocol position scanner + Postgres cache + public rate-limited `GET /api/scan` endpoint + scanner correctness unit tests (completed 2026-06-17)
- [x] **Phase 52: Suggestion Engine + Workflow Factory** - 4-category deterministic rule engine + 6-template workflow factory + remaining protocol adapters + Zerion breadth fallback + integration test (completed 2026-06-17)
- [x] **Phase 53: /scan UI** - Address input page, suggestion card list, WorkflowCanvas read-only preview, unauthenticated run/save CTAs (completed 2026-06-17)
- [x] **Phase 54: Auth Round-Trip + Persistence** - `pending_scan` cookie, `PendingScanRunner`, save-on-schedule wiring, Turnkey provision pre-flight, E2E funnel test (completed 2026-06-17)
- [x] **Phase 55: Polish + Hardening** - Abuse telemetry, cache sweeper cron, observability metrics, financial-advice disclaimer review (completed 2026-06-17)
- [x] **Phase 56: Spark + Sky Scan Adapters** - Native SparkLend (Aave-fork) + Sky sUSDS savings adapters completing SCAN-03; protocol-aware factory pool selection; scan-scoped DAI exclusion (read-only; Compound V3 deferred) (completed 2026-06-29)

---

## Phase Details

### Phase 51: Scanner Infrastructure
**Goal**: The multi-protocol position scanner, Postgres-backed cache, and public API endpoint exist and work correctly for a pasted Ethereum address, with per-IP rate limiting, per-chain timeout isolation, and correctness guards (HF=MAX_UINT256, Multicall3 soft-miss, proxy ABI, depeg) in place before any UI is built.
**Depends on**: Nothing (first phase of v1.13; reads existing `lib/rpc/`, `lib/contracts/multicall3.ts`, `lib/agentic-wallet/rate-limit.ts`, `lib/db/schema.ts` without modifying them)
**Requirements**: SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, SCAN-06, SCAN-07, SCAN-08, SCAN-09, SCAN-10, SCAN-11, SCAN-12, SCAN-13, SCAN-14, FUNNEL-01, TEST-01
**Success Criteria** (what must be TRUE):
  1. `GET /api/scan/0x{address}` returns HTTP 200 with no auth header required; the response includes detected Aave V3 and Lido positions on all supported chains where contract addresses are registered, stablecoin balances from the `supportedTokens` registry, and a `scannedAt` timestamp.
  2. A supply-only Aave V3 user (totalDebtBase === 0n) receives `healthFactor: null` with a "No active loan" marker in the response — never an astronomically large numeric value from MAX_UINT256.
  3. A slow or failing chain returns partial results with an `"unavailable"` marker rather than a 500 error; remaining chains' positions are always present in the same response.
  4. A fourth scan request from the same IP within one hour receives HTTP 429; a repeat scan within 5 minutes returns HTTP 200 instantly without issuing any RPC calls (served from Postgres cache).
  5. The scanner unit test suite — covering HF=MAX_UINT256 guard, Multicall3 soft-miss handling, EIP-1967 proxy ABI resolution, and depeg signal detection — passes with mocked RPC responses.
**Plans**: 8 plans (5 waves)
Plans:
- [x] 51-01-PLAN.md — Foundation: scan type contract + verified protocol-address registry + TEST-01 scaffold [wave 1] — COMPLETE (2026-06-16)
- [x] 51-02-PLAN.md — scan_results Postgres cache schema + [BLOCKING] file-based migration 0112 [wave 2]
- [x] 51-03-PLAN.md — Multicall3 batch harness (<=20, soft-miss) + per-chain 4s timeout fan-out [wave 2]
- [x] 51-04-PLAN.md — USD pricing: Chainlink feeds + depeg detection + DefiLlama fallback (N/A not $0) [wave 2]
- [x] 51-06-PLAN.md — Lido staking + stablecoin balance adapters (registry-driven, soft-miss) [wave 2]
- [x] 51-05-PLAN.md — Aave V3 adapter (account data + eMode + HF guard) + EIP-1967 proxy resolution [wave 3]
- [x] 51-07-PLAN.md — Scanner orchestrator: cache short-circuit + fan-out + pricing assembly + Zerion degradation [wave 4]
- [x] 51-08-PLAN.md — Public `GET /api/scan/[address]` route: validate + trusted-IP rate limit + ZERION_API_KEY scaffold [wave 5]

### Phase 52: Suggestion Engine + Workflow Factory
**Goal**: The deterministic suggestion engine maps any scan result to a ranked list of named suggestions, and the workflow factory deterministically constructs prefilled node/edge JSON for each suggestion — covering all four categories (health/yield/alert/claim), enforcing correct chain IDs, and validating every template reference — without calling the AI generate route.
**Depends on**: Phase 51 (ProtocolPosition types, scanner output shape, scan_results cache)
**Requirements**: SUGGEST-01, SUGGEST-02, SUGGEST-03, SUGGEST-04, SUGGEST-05, SUGGEST-06, SUGGEST-07, SUGGEST-08, SUGGEST-09, SUGGEST-10, PREFILL-01, PREFILL-02, PREFILL-03, PREFILL-04, PREFILL-05, PREFILL-06, PREFILL-07, TEST-02
**Success Criteria** (what must be TRUE):
  1. A scan result containing an Aave V3 lending position with healthFactor < 2.0 produces at least one health-category suggestion whose description references the actual protocol name, chain, current HF value, and USD debt amount; the alert threshold is floored at 1.3 (never `< 1.3` in the generated condition).
  2. A scan result with a stablecoin balance above $100 produces a read-only yield-category suggestion; a stablecoin with a Chainlink price deviation > 0.5% from $1.00 produces no yield suggestion for that asset.
  3. Every suggestion descriptor carries a required `chainId`; calling the workflow factory on any suggestion produces complete node/edge JSON in under 10ms with no AI API call, with every `{{@nodeId:Label.field}}` template reference resolving to an existing node in the output.
  4. The suggestion list is capped at 7, ranked health > yield > alert > claim (then by USD value descending within each category), and each suggestion carries a read/write label, a per-card risk note, and a global "not financial advice" disclaimer.
  5. Integration test: unauthenticated `GET /api/scan/{known-arbitrum-usdc-address}` returns HTTP 200, the response contains a stablecoin suggestion, and the prefilled workflow JSON for that suggestion carries `network: 42161` in the chain-specific node config.
**Plans**: 5 plans
- [x] 52-01-PLAN.md — Wave 0 scaffold: SuggestionDescriptor + PrefillWorkflow types, 3 failing test files
- [x] 52-02-PLAN.md — Suggestion engine: 4-category builders, dust filter, cap/rank, HF clamp, disclaimer
- [x] 52-03-PLAN.md — Factory core: validators (template-ref + MaxUint256), dispatcher, HF-monitor + stablecoin-yield shapes
- [x] 52-04-PLAN.md — Factory shapes: price-alert, reward-reminder, generic fallback + dispatcher wiring
- [x] 52-05-PLAN.md — Scan route extension (suggestions[]) + TEST-02 integration (Arbitrum USDC → network "42161")

### Phase 53: /scan UI
**Goal**: An anonymous visitor can paste an Ethereum address at `/scan`, see their DeFi positions and ranked suggestion cards rendered in the existing design system, click a suggestion to view a prefilled WorkflowCanvas preview in read-only mode, and reach the run/save CTAs — which gate on sign-in only when clicked.
**Depends on**: Phase 52 (SuggestionDescriptor type, workflow factory, scan API endpoint returning full response shape)
**Requirements**: SCANUI-01, SCANUI-02, SCANUI-03, SCANUI-04, SCANUI-05, SCANUI-06
**Success Criteria** (what must be TRUE):
  1. Navigating to `/scan` with no session shows the address input immediately; no 401, no redirect, no auth check fires; the page renders without an authenticated user.
  2. After entering a valid Ethereum address, suggestion cards appear showing name, description, category badge, chain name, and read/write label; no suggestions appear for dust positions below the minimum USD threshold.
  3. Clicking a suggestion card opens a read-only WorkflowCanvas preview of the prefilled workflow; the preview is rendered entirely with existing hub card primitives and design tokens — `node scripts/token-audit.js` reports zero new errors introduced by the scan components.
  4. "Run" and "Save on schedule" CTAs are visible in the preview panel; clicking either one while unauthenticated opens the existing `useAuthPrompt` sign-in flow without losing the current address or selected suggestion.
  5. The results area shows a `scannedAt` timestamp, per-chain "unavailable" badges for any chains that timed out, and a depeg banner when a stablecoin depeg signal is present in the scan result.
**Plans**: 5 plans (3 waves)
Plans:
- [x] 53-01-PLAN.md — Foundation: health badge tokens + scan E2E scaffold + ScanResponse fixture [wave 1]
- [x] 53-02-PLAN.md — Suggestion card cluster: CategoryBadge + ReadWritePill + SuggestionCard + skeleton [wave 2]
- [x] 53-03-PLAN.md — Results metadata: scannedAt header + unavailable badges + depeg banner + disclaimer [wave 2]
- [x] 53-04-PLAN.md — Preview drawer: read-only WorkflowCanvas (atom hydration) + confirmInputs + auth-gated CTAs [wave 2]
- [x] 53-05-PLAN.md — Page wiring: ScanInput + ScanResults state machine + app/scan/page.tsx + E2E green [wave 3]
**UI hint**: yes

### Phase 54: Auth Round-Trip + Persistence
**Goal**: After signing in from the `/scan` funnel, the pending scan intent is automatically resumed without user re-entry — the workflow is created, optionally scheduled, and the user lands on the workflow canvas; write suggestions additionally pre-flight a Turnkey wallet provision check.
**Depends on**: Phase 53 (run/save CTAs and `useAuthPrompt` integration in the UI; pending intent must be set before sign-in begins)
**Requirements**: FUNNEL-02, FUNNEL-03, FUNNEL-04, FUNNEL-05, TEST-03
**Success Criteria** (what must be TRUE):
  1. An anonymous user who clicks "Save on schedule", completes sign-in, and returns to the app finds the selected workflow already created, scheduled, and active — without re-entering the address or re-selecting the suggestion from the list.
  2. After the OAuth sign-in round-trip, the `/scan` page repopulates the original address (via `next`-param fallback) so the user's DeFi context is not lost if the pending cookie expires.
  3. A saved read-only monitoring workflow shows "Active" status and the configured schedule interval on the workflow detail page, routed through the existing `syncWorkflowSchedule` call.
  4. Clicking "Run" or "Save" on a write-type suggestion when the user has no provisioned wallet surfaces the Turnkey provision CTA; the CTA is absent when the user already has a wallet.
  5. The E2E test — paste a known Aave V3 position address, select the health-factor suggestion, preview the workflow, sign in, verify the saved scheduled workflow appears on the canvas — passes end-to-end.
**Plans**: 4 plans
Plans:
- [x] 54-01-PLAN.md — Wave 0: scaffold cookie/runner/wallet-check stubs + 3 RED unit tests + TEST-03 E2E
- [x] 54-02-PLAN.md — pending_scan cookie route + dialog callbackURL same-origin fix (FUNNEL-02)
- [x] 54-03-PLAN.md — persistSuggestion helper + PendingScanRunner + layout mount (FUNNEL-03/04)
- [x] 54-04-PLAN.md — drawer CTA wiring + wallet-check endpoint + TEST-03 green (FUNNEL-02/03/04/05, TEST-03)
**UI hint**: yes

### Phase 55: Polish + Hardening
**Goal**: The scanner is production-hardened with abuse telemetry wired into the existing Sentry alert, a cron-driven cache sweeper preventing unbounded table growth, observability metrics for cost tracking, and a reviewed financial-advice disclaimer on all suggestion cards.
**Depends on**: Phase 54 (all scan surfaces complete; hardening applied to the finished system)
**Requirements**: HARDEN-01, HARDEN-02, HARDEN-03, HARDEN-04
**Success Criteria** (what must be TRUE):
  1. Scan rate-limit blocks emit a structured event via `logAnonymousExecutionBlock("scan", ...)` visible in the existing anonymous-abuse Sentry alert — rate-limit abuse is observable without a dedicated dashboard.
  2. A cron job (following the existing `/api/cron/` pattern) deletes `scan_results` rows older than 1 hour; the table does not grow unboundedly between deployments.
  3. Scan observability metrics (scan duration, cache hit rate, Zerion call count) are emitted for cost tracking; the "not financial advice" disclaimer is present on every suggestion card and its copy has been reviewed before the feature is enabled on staging.
**Plans**: 4 plans (3 waves)
Plans:
- [x] 55-01-PLAN.md — Wave 0: 4 RED test files + sweeper throw-stub + SCAN_* MetricNames constants [wave 1]
- [x] 55-02-PLAN.md — HARDEN-02: HMAC scan-cache-sweeper cron (fail-closed, age-predicate delete) + staging/prod values.yaml [wave 2]
- [x] 55-03-PLAN.md — HARDEN-01/04: abuse telemetry on 429 + NEXT_PUBLIC_SCAN_ENABLED gate (API 404 + page) + reviewed disclaimer copy [wave 2]
- [x] 55-04-PLAN.md — HARDEN-03: scanner cache hit/miss counters + route scan-duration metric + Zerion counter + Prometheus TODO [wave 3]

### Phase 56: Spark + Sky Scan Adapters

**Goal**: Complete the deferred Spark + Sky portions of SCAN-03 with native scan adapters — an Ethereum address with a SparkLend loan yields a Spark health-factor suggestion that targets the Spark pool (not Aave's), and an address holding sUSDS yields a priced Sky savings-monitor suggestion that survives the dust filter — while curating scan stablecoin coverage to favour USDS over legacy DAI, all read-only and behind the existing scan system. Compound V3 remains out of scope.
**Depends on**: Phase 55 (the complete, hardened scan system: scanner orchestration, suggestion engine, factory, pricing layer)
**Requirements**: SCAN-03 (Spark + Sky portions), SCAN-04 (Sky savings), SCAN-15, PREFILL-08
**Design spec**: `specs/scan-spark-sky-adapters.md`
**Success Criteria** (what must be TRUE):
  1. An Ethereum address with a Spark (SparkLend) loan produces a Spark health-factor suggestion whose prefilled workflow reads the **Spark** pool (`0xC13e21…987`), not the Aave pool; a supply-only Spark address produces a price-alert suggestion (same paths as Aave).
  2. An Ethereum address holding sUSDS produces a single priced `sky` savings-monitor suggestion (category `claim`) that survives the dust filter, with the monitored token prefilled to the actual sUSDS address.
  3. USDS continues to surface as a stablecoin idle-yield suggestion; DAI no longer appears as a scanned balance or yield card, and the global `supported_tokens` registry is unchanged (scan-scoped exclusion only).
  4. No write-type suggestions are produced; all new suggestions are `readOrWrite: "read"` and pass the read-only factory guards.
  5. Native Spark/Sky positions take precedence over the dormant Zerion fallback for the same `(protocol, chainId)`; new unit tests pass and the existing scan suite stays green.
**Plans**: 5 plans (3 waves)

Plans:
- [x] 56-01-PLAN.md — Foundation: protocol union widen + verified Spark/Sky registry + ERC-4626 ABI + RED adapter tests [wave 1]
- [x] 56-02-PLAN.md — Spark (Aave-fork thin wrapper) + Sky (sUSDS ERC-4626) adapter implementations [wave 2]
- [x] 56-03-PLAN.md — Suggestion engine routing: SAVINGS_PROTOCOLS + spark/sky labels + Sky savings copy/prefill [wave 2]
- [x] 56-04-PLAN.md — Factory PREFILL-08: protocol-aware HF-monitor pool selection (Spark pool, not Aave) [wave 1]
- [x] 56-05-PLAN.md — Scanner wiring + Sky pricing (maxWithdraw→USDS via DefiLlama) + scan-scoped DAI exclusion [wave 3]
**UI hint**: no

### Phase 57: APY-Aware Stablecoin Yield Suggestions

**Goal**: Upgrade the read-only stablecoin idle-yield suggestion from a generic "consider deploying to a yield protocol" reminder into an APY-aware, destination-specific recommendation. For an idle USDS / USDC / USDT balance above the dust threshold, the suggestion names a concrete yield destination and its current APY — USDS → Sky Savings (sUSDS) at the live Sky Savings Rate; USDC / USDT → the best-available supply venue selected by live APY (ranked across Aave V4 / Spark / Morpho etc. via a yields source, NOT hardcoded to one protocol or version) — and the prefilled monitor workflow references that destination. Every APY is sourced from live data (never hardcoded) with graceful fallback to the existing generic copy on lookup failure. Remains fully read-only: no deposit/approve/write node is produced. The actual auto-deposit/auto-compound (Level B), including which protocol/version the deposit targets (Aave V4 hub-and-spoke vs others), is explicitly out of scope and tracked for the write-paths milestone.
**Depends on**: Phase 56 (Sky/sUSDS detection, the suggestion engine, the workflow factory, and the pricing/DefiLlama layer)
**Requirements**: YIELD-01 (USDS → Sky Savings APY), YIELD-02 (USDC/USDT → best supply venue by live APY), YIELD-03 (live APY source + graceful degradation), YIELD-04 (read-only guardrail preserved)
**Design spec**: `specs/scan-apy-yield-suggestions.md`
**Success Criteria** (what must be TRUE):
  1. A wallet holding idle **USDS** above dust produces a yield suggestion that names **Sky Savings (sUSDS)** and shows the current Sky Savings Rate (e.g. "earn ~X% APY"); the prefilled read-only monitor workflow references the sUSDS destination address.
  2. A wallet holding idle **USDC or USDT** above dust produces a yield suggestion that names the **best-available supply venue by live APY** (ranked across Aave V4 / Spark / Morpho etc. — selected by current rate, not hardcoded to a single protocol or version) and shows that venue's supply APY for the asset on that chain.
  3. Every APY shown is fetched from a **live source** (Sky Savings Rate on-chain / DefiLlama yields), never hardcoded; when the APY lookup fails the suggestion **degrades gracefully** to the existing generic monitor copy rather than showing a stale or $0 APY.
  4. **No write-type suggestion is produced** — all suggestions remain `readOrWrite: "read"` and pass the read-only factory guards (`validateNoApproveTokenNode` / `validateNoMaxUint256Approval`). The deposit/auto-compound action stays out of scope (see write-paths backlog item).
  5. Suggestion ranking/dedup still holds (one suggestion per `(symbol, chainId)`, capped at `MAX_SUGGESTIONS`); new unit tests pass and the existing scan suite stays green.
**Plans**: 3 plans (3 waves)

Plans:
- [x] 57-01-PLAN.md — Foundation: ApyEntry/ApyContext types + yields-client throw-stub + engine signature widening + RED tests (YIELD-01..04) [wave 1]
- [x] 57-02-PLAN.md — DefiLlama yields client (fetch + 15m cache + 4s timeout + filter/rank) + APY-aware engine copy [wave 2]
- [ ] 57-03-PLAN.md — Scan route pre-fetch + apyContext wiring + factory destination reference + route test (YIELD-01/02/04) [wave 3]
**UI hint**: no (reuses the existing suggestion card + read-only canvas preview; copy + data only)

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 51. Scanner Infrastructure | 8/8 | Complete   | 2026-06-17 |
| 52. Suggestion Engine + Workflow Factory | 5/5 | Complete   | 2026-06-17 |
| 53. /scan UI | 5/5 | Complete   | 2026-06-17 |
| 54. Auth Round-Trip + Persistence | 4/4 | Complete   | 2026-06-17 |
| 55. Polish + Hardening | 4/4 | Complete   | 2026-06-17 |
| 56. Spark + Sky Scan Adapters | 5/5 | Complete   | 2026-06-29 |
| 57. APY-Aware Stablecoin Yield Suggestions | 2/3 | In Progress|  |

---

## Backlog

### Phase 999.1: Stablecoin Yield WRITE Paths — Auto-Deposit / Auto-Compound (BACKLOG)

**Goal:** Make the stablecoin yield suggestion ACTIONABLE, not just advisory. Phase 57 (Level A) detects idle USDS/USDC/USDT and recommends a destination + APY ("move idle USDS to sUSDS for ~X%") but is read-only — it can only monitor/alert. This epic adds the WRITE path: a workflow that actually deposits idle stablecoins into the yield destination (USDS → sUSDS Sky Savings; USDC/USDT → the best supply venue — likely Aave V4's hub-and-spoke markets, live on mainnet since 2026-03-30, vs Spark/Morpho) on a schedule or balance threshold, then optionally auto-compounds. Targeting V4's spoke model (vs the legacy V3 pool the scan currently reads) is itself a design decision for this epic.
**Why it's parked:** Requires the deferred write machinery the whole v1.13 scan funnel intentionally excluded — Turnkey wallet provisioning for the funnel user, EXACT (non-MaxUint256) ERC20 approvals, ask-tier / execution-safety gating, and selectively lifting the read-only factory guards (`validateNoApproveTokenNode` / `validateNoMaxUint256Approval`) for this path only. Comparable in size to its own milestone.
**Trigger to promote:** after Phase 57 (Level A, read-only APY-aware suggestions) ships and the write-path safety design (approvals + ask-tier + wallet provisioning) is scoped.
**Prior art / cross-refs:** already noted in `.planning/REQUIREMENTS.md` → "Future Requirements (deferred)" ("Stablecoin idle-yield WRITE path: auto-deposit to a vault via Turnkey wallet (exact-approval, ask-tier safety)") and "Out of Scope" ("Stablecoin write auto-deposit in v1.13"). The Phase-52 `validateNoMaxUint256Approval` / PREFILL-07 guard already anticipates this path (exact-approval enforcement).
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)
