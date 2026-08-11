---
status: passed
phase: 45
phase_name: Back/Forward Hydration Fix
verified_at: 2026-05-01
verified_by: gsd-autonomous (orchestrator + spawned executors)
plans_complete: 6
plans_total: 6
---

# Phase 45 Verification — Back/Forward Hydration Fix

## Status

**passed** — all 6 plans shipped, automated UAT GREEN, Chrome cross-browser sweep verified live; FF + Safari deferred per user accept (recorded in `45-UAT.md`).

## Plan completion

| Plan | Wave | Commit | Status |
|------|------|--------|--------|
| 45-01 | 1 | `06c1867f` | done |
| 45-02 | 1 | `d4e61a36` | done |
| 45-03 | 1 | `2df832d1` | done |
| 45-04 | 2 | `30a05ad0` | done |
| 45-05 | 2 | `554e7d93`, `84d1eb4f`, `69063092` | done |
| 45-06 | 3 | `f7e65e7c` (ADR backfill), `69f0fee4` (STATE.md), `333eb63e` (ROADMAP mark) | done |

## Must-haves (from PLAN.md)

- BFCACHE-01 — Root-layout dev-only `<Script>` in `app/layout.tsx`, detection `performance.getEntriesByType('navigation')[0]?.type === 'back_forward'`, recovery `window.location.reload()`, JSX-gated NODE_ENV. **Met** (commit `06c1867f`).
- BFCACHE-02 — `app/hub/layout.tsx` no longer contains `HUB_DEV_BFCACHE_RELOAD`, `<Script>`, or `next/script`. HubLayout is metadata-only passthrough. **Met** (commit `d4e61a36`).
- BFCACHE-03 — `tests/unit/hub-layout-bfcache.test.ts` deleted; new `tests/unit/root-layout-bfcache.test.ts` asserts contract against `app/layout.tsx` AND regression-by-absence in `app/hub/layout.tsx`. 20/20 tests pass. **Met** (commit `30a05ad0`).
- BFCACHE-04 — `tests/e2e/playwright/back-forward-hydration.test.ts` exercises `/hub → /billing → goBack` with the prescribed assertions. Both dev (`'reload'`) and prod (`'navigate'`) branches pass 5/5. **Met** (commit `69063092`).
- BFCACHE-05 — `playwright.config.ts` `NEXT_BUILD_MODE` switch, `pnpm test:e2e:bfcache:dev` and `pnpm test:e2e:bfcache:prod` scripts, Chromium-only CI, FF/WebKit opt-in via local invocation. **Met** (commits `554e7d93`, `84d1eb4f`).
- BFCACHE-06 — `specs/architecture/back-forward-hydration.md` ADR with bug signature, working hypothesis, why workaround is correct, what would constitute a real upstream fix, explicit DEFERRED decision on filing an upstream Next.js issue. **Met** (commits `2df832d1`, `f7e65e7c`).
- BFCACHE-07 — Local UAT gate green, STATE.md decisions entry added documenting supersession of `cef214f0` by `06c1867f`, ADR Owner field backfilled with full Phase-45 commit list. **Met** (commits `69f0fee4`, `f7e65e7c`).

## Success criteria from ROADMAP.md

1. Button count + interactive elements present after back/forward navigation. **Met** — Chrome live verification (50 buttons after `history.back()` from `/billing` to `/hub`, matches initial render). Playwright suite asserts the same parity in both dev and prod.
2. Dev-only `<Script>` in `app/hub/layout.tsx` deleted; no other page-level workarounds remain. **Met** (`d4e61a36`; unit test asserts absence; no other page-level workarounds exist in the codebase per `45-RESEARCH.md`).
3. `tests/e2e/playwright/back-forward-hydration.test.ts` created with the prescribed flow + assertions. **Met** (`69063092`).
4. Same test runs against `pnpm dev` AND `pnpm start`. **Met** — `pnpm test:e2e:bfcache:dev` (5/5 pass, navigation.type `'reload'`); `pnpm test:e2e:bfcache:prod` (5/5 pass, navigation.type `'navigate'`).
5. Local UAT gate: `pnpm check` + `pnpm type-check` + `pnpm test:e2e --grep "back-forward"` green. **Met** (recorded in `45-UAT.md`).

## Human verification

- **Chrome (real, via `claude-in-chrome` MCP):** PASS — verified live during the UAT checkpoint.
- **Firefox + Safari:** DEFERRED per user accept (autonomous workflow checkpoint, 2026-05-01). Workaround is browser-agnostic JS; PerformanceNavigationTiming.type Baseline Widely Available since 2021. Recorded as a manual TODO in `45-UAT.md`.

## Deferred items (non-blocking)

- Repo-wide Biome baseline drift (~263 errors) is pre-existing on the `feature/v1.11-phase-42-foundations` branch tip, unchanged by Phase 45. Recommend addressing in a dedicated lint-cleanup phase before opening the Phase 45 PR.
- Ultracite/Biome JSON parse regression — `pnpm check` wrapper failure is orthogonal to Phase 45.
- Filing an upstream Next.js issue — explicitly DEFERRED per the ADR; revisit if Next.js 16.3+ ships a fix for any of the related issues catalogued in the ADR's "Bounding the Hypothesis Space" section.

## Outcome

Phase 45 is GREEN. Ready for Phase 44.
