# Milestones

## v1.11 Marketplace Discovery & Hub UX (Shipped: 2026-05-01)

**Linear issues:** KEEP-303, KEEP-326, KEEP-297, KEEP-368
**Phases:** 4 phases (42-45), 42 plans
**Timeline:** 2026-04-29 → 2026-05-01 (3 days)
**Repos touched:** `keeperhub`

**Key accomplishments:**
- `/hub` consolidated into a tabbed shell (Protocols default / Workflows / Marketplace) with Radix Tabs + `?tab=` query-param URL contract via `router.replace`. Hero rewritten to "Hub". Phase-43 view-shell content lifted intact into the Workflows tab; standalone Protocols strip + "Templates" header/divider deleted.
- Marketplace tab is a server-component popularity-sorted leaderboard with a Drizzle GROUP-BY join wrapped in `unstable_cache(300s)`, cursor pagination LIMIT 50, and a privacy-whitelisted SELECT (zero leaks of `creatorWalletAddress`/`payerAddress`/`amountUsdc`/`userId`/`organizationId`). Sort dropdown shows Popular (default) + Newest only — earnings sort EXPLICITLY ABSENT (deferred to v1.11.x or v1.12).
- MCP API + tool symmetry: `GET /api/mcp/workflows?sort=popular|recent` and `search_workflows` MCP tool gain matching `sort` param; tool count unchanged.
- Phase 43 anonymous + auto-anonymous Use-template OAuth round-trip via `pending_template` HttpOnly cookie + `PendingTemplateRunner` (NO localStorage); deep-link `/hub/tags/[tag]` route with `generateStaticParams` + tag-specific metadata + reserved-slug validator; Cards/List view toggle persisted in `hub_view` cookie (server-readable, NO localStorage); sidebar Sort + Tags reorganization with `useTransition` + `router.push` scroll preservation.
- Phase 42 shared primitives: single `WorkflowIOOverlay` (Radix Tabs) replacing split import/export; shared `SignInPromptOverlay` + `useAuthPrompt` hook; logged-out left-nav (`requireAuth: boolean` per item + first-paint `useSession().isPending` skeleton + `usePersistedNavState` versioning); import schema hardened (`.passthrough()` -> `.strict()`, `.max()` caps, https-only webhooks, `Content-Length` 413 guard, code-step gate).
- Phase 45 root-layout dev-only `<Script>` (`app/layout.tsx`, commit `06c1867f`) supersedes the per-page bfcache workaround; replacement unit test + dual-mode Playwright suite (dev+prod) + ADR. Live cross-browser sweep verified in real Chrome via `claude-in-chrome` MCP for both Phase 44 + Phase 45.

**Deferred / parked:**
- MARKET-FUTURE-01..04 + HUB-FUTURE-02 + MARKET-10 SUPERSEDED + cross-tab unified search wiring + Marketplace tags column + cross-browser CI runs + upstream Next.js bfcache PR — see `milestones/v1.11-ROADMAP.md` for full list.
- Phase 42 manual UAT (42-10) and Phase 43 retrospective `VERIFICATION.md` are documentation tracking debt; phases ARE functionally shipped via downstream verification.

---

## v1.10 Agentic Wallet & Marketplace Plumbing (Shipped: 2026-04-29)

**Linear issues:** KEEP-364, KEEP-361, KEEP-378
**Phases:** 2 phases (40-41), 9 plans
**Timeline:** 2026-04-29 (single day)
**Repos touched:** `keeperhub` (server fix + MCP curator surface), `agentic-wallet` (paymentHint API)

**Key accomplishments:**
- Fixed `verification-failed` x402 facilitator rejection that blocked all fresh Turnkey sub-orgs from paying x402-gated KeeperHub workflows. Root cause: `buildPaymentConfig` emitted empty `extra: {}` while `@x402/evm@2.9.0` requires `extra.name` and `extra.version`. One-line server fix in `lib/payments/x402/payment-gate.ts` adds `{ name: "USD Coin", version: "2" }`. Local smoke verified the 402 body now carries the `extra` fields end-to-end. (KEEP-364)
- Added `paymentHint: "x402" | "mpp" | "auto"` per-call override on `signer.fetch` and `pay()` in `@keeperhub/wallet`. Pure `selectProtocol(x402, mpp, hint)` function preserves existing `auto` (x402-first) default byte-for-byte. New typed `KeeperHubError` codes `X402_NOT_OFFERED` and `MPP_NOT_OFFERED` when the requested protocol is not in the 402 challenge. 9-case routing matrix verified live against the built tarball. (KEEP-361)
- Shipped 4 marketplace curator MCP tools (`list_workflow`, `unlist_workflow`, `update_workflow_listing`, `get_workflow_listing`) backed by `app/api/mcp/workflows/[slug]/listing` (POST/PATCH/DELETE auth-required, GET public + IP-rate-limited). Shared `lib/mcp/listing.ts` state-machine helper used by both the new curator surface and the existing PATCH workflow route — single source of truth for listing lifecycle (slug stickiness across unlist/relist, `listedAt` refresh on relist, `priceUsdcPerCall` change rejected while listed with 409). Cross-org access returns 404 to prevent enumeration. (KEEP-378)
- 11 named regression-guard test files across both repos (7 in agentic-wallet, 4 in keeperhub) — full test green: 127 tests pass in agentic-wallet, all curator unit + integration tests pass in keeperhub.
- Phase 41 route conflict (`[id]` vs `[slug]` at same dynamic level) caught only during local `pnpm dev` smoke and merged into a single `[slug]/listing/route.ts` — useful signal that route-handler unit tests miss Next.js path-conflict detection.

**Deferred / parked:**
- WX402-02 live CDP smoke against staging facilitator with a fresh Turnkey sub-org — requires user post-merge.
- `wallet.executeListing(slug, args, opts)` 2-line sugar (WHINT-FUTURE-01) — defer until paymentHint telemetry exists.
- Default protocol flip x402-first → MPP-first (WHINT-FUTURE-02) — pending data from this milestone.
- Suspect 4 (CDP fresh-sub-org allowlist) — not empirically ruled out; if WX402-02 still fails after staging deploy, file as WX402-FUTURE-01.

---

## v1.7 Agent-Callable Workflows (Shipped: 2026-04-21)

**Linear issues:** KEEP-176, KEEP-148, KEEP-139, KEEP-261, KEEP-259, KEEP-294
**Timeline:** 2026-03-30 to 2026-04-21

**Key accomplishments:**
- Shipped the full agent-callable marketplace: workflows list to an MCP endpoint, AI agents discover them at runtime via the `search_workflows` meta-tool, and call them via `call_workflow` with the declared input schema
- x402 + MPP dual-protocol settlement: x402 on Base USDC (CDP facilitator) and MPP on Tempo USDC.e (mppx local HMAC). Single call route emits both 402 challenges side-by-side so any agent wallet ecosystem can pay
- Instruction-only write workflows: for write-type workflows, `call_workflow` returns unsigned calldata `{to, data, value}` for the caller's wallet to submit. No custody, no key management on the server side
- ERC-8004 registration: single KeeperHub identity NFT on Ethereum mainnet, `keeperhub.eth` ENS, HTTPS-hosted registration file updated on list/unlist without on-chain writes
- Discovery scanner compatibility: agentcash, x402scan, mppscan all parse canonical `PAYMENT-REQUIRED` + `extensions.bazaar.schema`. CDP Bazaar (agentic.market) indexing wired via `extensions.bazaar.discoverable:true` + category/tags + public resource URL
- Creator economics: `workflow_payments` table with idempotent recording, earnings dashboard with per-chain breakdown (Base vs Tempo), docs tooltip linking creators to dual-chain rationale
- Public docs: `docs/workflows/paid-workflows` (creator-facing) and `docs/ai-tools/agent-wallets` (caller-facing, wallet-neutral covering agentcash and Coinbase agentic-wallet-skills)
- Tempo chain ID standardized on `4217` (legacy `42420` removed from live code paths, CI grep guard prevents re-introduction)

**Deferred / parked:**
- KEEP-264 (`x-discovery.ownershipProofs` on `/openapi.json`) -- parked pending scanner spec confirmation; no live scanner consumes ownership proofs today
- KEEP-260 (MPP settlement reconciliation worker) -- parked pending mppx exposing a tx hash post-verification; zero production failures observed
- KEEP-258 (generic x402-fetch plugin action) -- assigned to Joel, queued

---

## v1.4 Agent Team (Shipped: 2026-03-01)

**Phases completed:** 6 phases (13-18), 13 plans
**Files changed:** 34 (+3,891 / -637)
**Commits:** 27
**Timeline:** 1 day (2026-03-01)
**Git range:** 395d6f367..b48ab73ad

**Key accomplishments:**
- Built Orchestrator agent (Opus) with deterministic Blueprint pipeline (DECOMPOSE -> RESEARCH -> IMPLEMENT -> VERIFY -> PR)
- Created 4 worker agents (Builder, Verifier, Researcher, Debugger) with least-privilege tool access and structured output formats
- Rewrote /add-protocol, /add-plugin, /add-feature as thin Orchestrator wrappers with extracted domain knowledge documents
- Defined 4 enforceable safeguards (SAFE-01-04): human review gate, 2-round iteration limit, build verification, Verifier approval
- Created Vitest skill for automated plugin step test generation
- Added scoped CLAUDE.md files for keeperhub/plugins/ and tests/e2e/playwright/

**Known Tech Debt (4 minor items):**
- GitHub branch protection not configured on staging (requires manual GitHub UI)
- Phase 14/16 SUMMARY frontmatter uses provides/requires format instead of requirements-completed
- AGENT-05 requirement text overclaims "checkpoint management" vs actual scientific method implementation
- Minor context block asymmetry between add-feature.md and add-protocol/add-plugin.md

---

## v1.0 Service Extraction (Shipped: 2026-02-12)

**Phases completed:** 4 phases, 12 plans, 2 tasks

**Key accomplishments:**
- Extracted sc-event-tracker and sc-event-worker to keeperhub-events repo with independent GHA deployment pipelines
- Built 6 internal HTTP API endpoints for scheduler operations (replacing direct DB access)
- Refactored scheduler dispatcher and executor to HTTP-only communication
- Extracted scheduler to keeperhub-scheduler repo with multi-stage Docker build and change detection
- Disabled old monorepo deployment workflows and created cleanup PR #195
- git-filter-repo deferred pending stability verification

---


## v1.1 OG Image Generation (Shipped: 2026-02-12)

**Phases completed:** 1 phase (5), 2 plans

**Key accomplishments:**
- Fixed OG image generation in production K8s build with outputFileTracingIncludes for @vercel/og WASM
- Default, hub, and workflow OG images render valid PNGs with correct font loading at runtime

---


## v1.2 Protocol Registry (Shipped: 2026-02-20)

**Phases completed:** 4 phases (6-9), 10 plans
**Files changed:** 21 (+2,212 / -760)
**Timeline:** 2 days (2026-02-19 to 2026-02-20)

**Key accomplishments:**
- Created defineProtocol() typed API with runtime validation for declarative protocol definitions
- Extracted read/write-contract core logic to -core.ts files enabling reuse without bundler violations
- Built protocolToPlugin() auto-generation pipeline -- protocol definitions become workflow nodes automatically
- Extended discover-plugins to scan keeperhub/protocols/ and generate registrations with zero manual boilerplate
- Added ABI auto-resolution from block explorers with 24h in-memory cache and proxy detection (EIP-1967/1822/2535)
- Built Hub UI Protocols tab with protocol grid, inline detail view, action list, and workflow navigation

---


## v1.3 Direct Execution API (Shipped: 2026-02-20)

**Phases completed:** 3 phases (10-12), 6 plans
**Timeline:** 2026-02-20

**Key accomplishments:**
- Created direct_executions and organization_spend_caps DB tables via drizzle-kit migration
- Extracted transfer-funds-core.ts and transfer-token-core.ts for reuse outside "use step" context
- Added organizationId bypass to writeContractCore/readContractCore for non-workflow execution
- Built API key authentication (SHA-256 hash, Bearer kh_ prefix) with rate limiting (60 req/min sliding window)
- Spending cap enforcement per organization with BigInt-safe daily limit checking
- POST /api/execute/transfer -- ETH and ERC-20 token transfers with execution audit logging
- POST /api/execute/contract-call -- Read-only calls return synchronously, write calls return 202 with executionId
- POST /api/execute/swap -- 501 placeholder for future DEX integration
- POST /api/execute/check-and-execute -- Conditional execution: read state, evaluate BigInt condition, optional write
- GET /api/execute/{executionId}/status -- Execution polling with org-scoped access control
- 27 integration tests covering all endpoints (tests/integration/direct-execution-api.test.ts)

---


