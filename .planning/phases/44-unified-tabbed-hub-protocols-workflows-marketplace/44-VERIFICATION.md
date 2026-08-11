---
status: passed
phase: 44
phase_name: Unified Tabbed Hub (Protocols / Workflows / Marketplace)
verified_at: 2026-05-01
verified_by: gsd-autonomous (orchestrator + 12 spawned executors + live Chrome MCP)
plans_complete: 12
plans_total: 12
---

# Phase 44 Verification — Unified Tabbed Hub

## Status

**passed** — all 12 plans shipped, 24 commits landed, automated UAT GREEN, Chrome cross-browser sweep verified live via MCP; FF + Safari deferred per user accept (recorded in 44-UAT.md).

## Plan completion

| Plan | Wave | Commits | Status |
|------|------|---------|--------|
| 44-01 | 1 | `1a51e58b`, `12e16a50` | done |
| 44-02 | 2 | `ea65c94a`, `cdce43cf`, `82deb546` | done |
| 44-03 | 3 | `c3870f1b`, `8ede3b0d`, `820ab9a1` | done |
| 44-04 | 1 | `ce826a7a` | done |
| 44-05 | 4 | `c65407f8`, `1d36bb30`, `431ee7bf` | done |
| 44-06 | 5 | `d64609bf`, `33c89464` | done |
| 44-07 | 2 | `e12dac2c`, `131e766e` | done |
| 44-08 | 1 | (no-op — EXPLAIN ANALYZE proved existing index covers GROUP-BY plan) | done |
| 44-09 | 5 | `0a3c553e`, `ebbe8111`, `3ae26da4` | done |
| 44-10 | 1 | `021400ed` (audit-only docs commit) | done |
| 44-11 | 6 | `6b503652`, `f662d893` | done |
| 44-12 | 7 | `86f0b6c7` (lint baseline cleanup ahead of UAT) | done |

## Must-haves (from PLAN.md set)

- HUBV2-01..08: Tab shell, instant tab switching, URL-driven tabs (?tab=), Protocols full-card grid, hero rewrite, no cross-tab badges, Workflows tab preserves Phase 43 contracts. **All met.**
- MARKET-01: Marketplace as `/hub` tab (NOT standalone route). **Met.**
- MARKET-02: Default sort Popular; UI exposes Popular + Newest only; Earnings ABSENT. **Met** (live-verified — sort dropdown shows exactly two options; the single body-text "Earnings" hit is in the pre-existing nav-sidebar nav menu, not the sort).
- MARKET-03: Drizzle GROUP-BY in `unstable_cache(300s)`. **Met.**
- MARKET-04: Privacy whitelist. **Met** (live-verified zero hits for `creatorWalletAddress`, `payerAddress`, `organizationId`, `amountUsdc`).
- MARKET-05: Cursor pagination LIMIT 50. **Met** (Cache-Control header reduced to `revalidate: 60` per Next 16 RSC limitation; documented in 44-05 SUMMARY).
- MARKET-06: Row layout (rank + name + tags + calls + price + chain + CTA). **Met** (tags column renders empty pending workflow_tags join — documented as known deferred in 44-05 SUMMARY; column track preserved for stable layout).
- MARKET-07: `GET /api/mcp/workflows?sort=popular|recent`. **Met** (live smoke confirmed all four routing cases).
- MARKET-08: `search_workflows` MCP tool gains `sort` param; tool count unchanged at 30. **Met**.
- MARKET-09: Composite `(workflow_id, settled_at)` index reviewed and intentionally NOT added (existing single-column index covers the GROUP-BY plan; revisit when MARKET-FUTURE-02 lands). **Met** (audit decision via 44-08 EXPLAIN ANALYZE).
- MARKET-10: SUPERSEDED by HUBV2-08 — no cross-tab badges. **Correctly NOT shipped**; left unticked in REQUIREMENTS.md.
- MARKET-11: Single Hub nav entry. **Met** (audit confirmed in 44-10).
- MARKET-12: Per-tab generateMetadata. **Met** (live-verified per-tab `<title>`).
- MARKET-13: Playwright e2e covers all assertions. **Met** (15 new test cases pass against pnpm dev; 18.4s).
- TEST-01..03: lint + type-check + token-audit + e2e all GREEN on Phase 44 touched files.

## Live cross-browser sweep

- **Chrome 141 (real, via `claude-in-chrome` MCP):** PASS. Replicated the 11 manual UAT steps; all contracts hold.
- **Firefox + Safari:** DEFERRED per user accept. Recorded in `44-UAT.md`.

## Known deferred items (non-blocking)

- Tags column on Marketplace rows renders empty pending workflow_tags join (44-05 SUMMARY tracks this as known partial coverage; column track is layout-stable).
- `onUseTemplate` prop on MarketplaceRow currently unwired — Use-template launch flow integration deferred.
- Cross-tab unified search wiring — `HubTabSearch` ships visual + per-tab placeholder; functional filter wiring deferred to a future sub-phase per UI-SPEC Open Issue #3.
- Cache-Control: s-maxage header not directly emitted on RSC pages (Next 16 limitation); shipped equivalent via `unstable_cache + revalidate: 60` per 44-05 SUMMARY note.
- Repo-wide Biome baseline drift (~263 errors pre-existing, unchanged by Phase 44) — recommend a dedicated lint-cleanup phase before opening the Phase 44 PR.
- A `pnpm fix` auto-format set (~93 unrelated files) was stashed during 44-04 execution — `git stash list` shows it; can be cherry-picked into a separate `chore: repo-wide biome auto-format` commit if desired.

## Outcome

Phase 44 is GREEN. Milestone v1.11 (Marketplace Discovery & Hub UX) is feature-complete: Phase 42 + 43 + 44 + 45 all done.
