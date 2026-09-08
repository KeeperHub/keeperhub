# Back/Forward Navigation Hydration Recovery (Phase 45 ADR)

**Date:** 2026-05-01
**Status:** Workaround shipped at root layout. Root cause not isolated within the time-boxed investigation; working hypothesis recorded below.
**Scope:** Next.js 16.2.x App Router, dev mode (Turbopack), client-component-heavy routes.

This ADR documents the dev-only `back_forward` navigation hydration race observed on `/hub` and `/billing` and the reasoning behind the root-layout `<Script>` workaround that ships in Phase 45. The original per-page workaround was a `<Script>` block on `app/hub/layout.tsx` (see the `## Status` section below for the historical commit reference). Phase 45 generalizes that fix to `app/layout.tsx` so every route inherits the recovery, deletes the per-page version, and captures the investigation in this document.

## Symptom

Bug signature observed in dev (paraphrased from `45-RESEARCH.md` `## Summary`):

- On a `back_forward` navigation entry (browser back/forward gesture or `Cmd+Shift+T` tab restore), the React Flight payload (`__next_f` buffer) and `__reactContainer*` markers are missing from the restored DOM.
- Client-component-heavy pages (`/hub`, `/billing`) are stuck on the SSR skeleton with zero interactive elements (`document.querySelectorAll('button').length === 0`). Org switcher, sidebar tag links, view toggles — none of them mount.
- Reproduces only on `pnpm dev` (Turbopack default in Next.js 16.2.2). `pnpm build && pnpm start` is unaffected — same flow rehydrates cleanly without the workaround.
- `Cmd+Shift+T` (tab restore) and the browser back/forward gesture both produce a navigation entry of type `back_forward`, so the contract covers both.
- Refreshing the page (`Cmd+R` or programmatic `window.location.reload()`) fully recovers — the race is in the back/forward restoration path, not in initial render.

## Investigation

Time-boxed at approximately 4 hours per `45-CONTEXT.md` `## Decisions`. Steps performed:

- Read the original per-page workaround commit and the surrounding Phase 43 plan/research to confirm prior-art assumptions.
- Compared `pnpm dev` (Turbopack) and `pnpm build && pnpm start` outputs for `/hub` and `/billing`. Confirmed the bug only appears in dev, not prod.
- Inspected `__next_f` buffer state in the restored vs fresh-nav DOM (devtools console after `page.goBack()`). On a broken restore the array exists but has no `push` entries from the streamed RSC payload.
- Inspected `<head>` ordering of preload links and RSC chunk script tags after a back/forward restore vs a hard nav. Order looks similar; the missing piece is the streamed Flight payload, not script tag presence.
- Surveyed five nearby Next.js GitHub issues (catalogued under `## Bounding the Hypothesis Space`). None matches exactly; together they bound the hypothesis space.
- Webpack-mode reproduction (`next dev --no-turbo`): not attempted in this round — deferred. The workaround is identical regardless of bundler, so the cost/benefit of confirming Turbopack-only vs Webpack-too did not justify the additional time within the budget. Result feeds the optional upstream filing decision and can be revisited if Next.js 16.3 stabilizes the area.

Outcome: Root cause not isolated within the 4-hour time budget; working hypothesis recorded below. This was an expected outcome — `45-CONTEXT.md` explicitly authorized shipping the workaround whether or not a clean upstream cause was identified.

## Working Hypothesis

The most likely cause is a streaming RSC payload race interacting badly with Turbopack's HMR chunk delivery on a `back_forward` navigation restore. In a normal navigation, the Next.js dev server streams the Flight payload (`__next_f.push(...)` calls) into the document body, and React's hydrator consumes those entries to attach interactive behaviour to the SSR HTML. On a `back_forward` restore, the browser reuses the cached HTML but the dev server does not re-emit the Flight payload — and Turbopack's HMR connection has not yet pushed the route's chunks either. React sees the SSR markup with no Flight data to drive hydration, so the tree mounts but no client components ever attach event handlers. The same race does not exist in `pnpm start` because the prod server emits a static `__next_f` blob inline in the HTML, so the cached document already contains everything React needs.

This hypothesis is consistent with the three nearby Next.js issues catalogued in `## Bounding the Hypothesis Space` below — the streaming-RSC soft-nav stuck issue, the bfcache + App Router router cache inconsistency issue, and the Turbopack hydration delay issue. It is not proven — a clean isolated repro would require capturing the dev server's streaming output during a `back_forward` restore and confirming the absence of Flight chunks, which was outside the time budget.

## Bounding the Hypothesis Space

No single open Next.js issue is a perfect match for the Phase 45 bug signature. The five issues below are the closest known relatives and together bound the hypothesis space (sourced from `45-RESEARCH.md` `## Sources`):

- https://github.com/vercel/next.js/issues/44477 — bfcache restore inconsistency between Safari and Chrome (App Router router cache surface). Closed as not planned. Demonstrates `pageshow` + `event.persisted` as an alternative detection mechanism. Not a perfect match: the bug it describes is router-cache divergence, not missing Flight payload.
- https://github.com/vercel/next.js/issues/86151 — `loading.tsx` causing soft-navigation to get stuck (prod-mode but related class). Same family of streaming-RSC failure modes. Not a perfect match: prod-mode, not dev-only; involves `loading.tsx` boundary, which the Phase 45 routes do not use.
- https://github.com/vercel/next.js/issues/90684 — Turbopack Pages Router hydration delayed in background tabs. Adjacent symptom (visibility-state-driven hydration delay). Not a perfect match: Pages Router (not App Router), tab-visibility trigger (not back/forward gesture).
- https://github.com/vercel/next.js/issues/54184 — App Router back-button crash (Next.js 13.4.17 era). Same trigger (back navigation tripping App Router internals) but materially older codebase; the modern App Router has rewritten this path multiple times since. Not a perfect match: predates the React 19 / streaming-RSC architecture in use today.
- https://github.com/vercel/next.js/discussions/57644 — Cache-Control headers preventing bfcache restoration. Related but tangential: the symptom there is bfcache being disabled entirely, not bfcache restoration succeeding but failing to re-hydrate. Phase 45's symptom is the latter — the page IS restored from bfcache, it just lacks the Flight payload to drive hydration.

None of the five is a 1:1 match. Filing a fresh issue with a minimal repro is OPTIONAL per `45-CONTEXT.md` `## Decisions` — see `## Decision: Filing an Upstream Issue` below.

## Why the Root-Layout Script Fix Is Correct

**Detection contract:** `performance.getEntriesByType('navigation')[0]?.type === 'back_forward'`. This is the `PerformanceNavigationTiming.type` API, Baseline Widely Available since October 2021 (95.97% global support — Chrome 57+, Firefox 58+, Safari 15+, iOS Safari 15.2+, Edge 12+). No race window: the navigation entry is populated by the time any user JS runs. Same detection used by the original per-page workaround and now by the root-layout version.

**Recovery action:** `window.location.reload()`. Converts the back/forward into a fresh navigation, the Next.js dev server re-streams the Flight payload, and React hydrates cleanly. Soft `router.refresh()` was explicitly rejected in `45-CONTEXT.md` `## Decisions` because the race is in client hydration — refetching the RSC payload alone does not re-attach the React root once the broken hydration has already occurred.

**Build-time gate:** `process.env.NODE_ENV === "development"` wraps the JSX `<Script>` element, not the script string. Webpack and Turbopack both inline-substitute `process.env.NODE_ENV` at build time and dead-code-eliminate the entire conditional branch in production bundles. Result: zero production runtime cost, zero production bundle bytes for this workaround. The unit test (plan 45-04) enforces the gate by asserting that `process.env.NODE_ENV` appears before the `<Script>` JSX in source order.

**Why root layout (not per-page):** Every route benefits without per-page opt-in. Future client-heavy routes (e.g., the Phase 44 unified `/hub` tabbed shell that recommended Phase 45 land first) inherit the recovery automatically. The `<Script strategy="beforeInteractive">` element in App Router is documented to be relocated into `<head>` regardless of JSX position, so the visual placement at the bottom of `<body>` in `app/layout.tsx` is documentation only — the script always emits into `<head>` and runs before React hydration begins.

**Why `strategy="beforeInteractive"`:** The recovery script must run before React tries to hydrate the broken tree. `afterInteractive` and `lazyOnload` both run too late — by the time they execute, React has already attempted hydration and the tree is in an inconsistent state. Only `beforeInteractive` runs early enough.

**Why a stable `id`:** Next.js requires inline `<Script>` elements to carry a stable `id` for cross-route deduplication. The root-layout script uses `id="root-dev-bfcache-reload"` (the per-page version used `hub-dev-bfcache-reload`).

**Why NOT inject anything into the React tree:** The script only calls `window.location.reload()` and never touches React internals. Mutating the React tree from a `beforeInteractive` script would create a worse failure mode by interfering with hydration directly. Reload is the safest recovery action because it sidesteps React entirely.

## What Would Constitute a Real Upstream Fix

The ideal fix lives in Next.js itself: ensure the `__next_f` Flight payload is always reattached to the DOM on a `back_forward` navigation entry, even if the original RSC stream was interrupted, never completed, or was never delivered to the restored document. Two plausible upstream fix shapes:

1. Re-stream the Flight payload on bfcache restore — when the dev server detects a `back_forward` request that would consume a previously-streamed route, re-send the chunks so the restored document sees them.
2. Detect empty `__next_f` client-side and trigger a soft refetch automatically — let Next.js's runtime check, on `pageshow` with `event.persisted === true`, whether the Flight buffer is populated and silently re-fetch the RSC payload if not.

Either approach would let us delete the workaround. Concretely, when a Next.js release ships the upstream fix, the following can all be removed from KeeperHub:

- The `ROOT_DEV_BFCACHE_RELOAD` const in `app/layout.tsx`.
- The `next/script` import in `app/layout.tsx` (assuming no other root-layout Script exists at the time).
- The conditional `<Script id="root-dev-bfcache-reload" strategy="beforeInteractive">{ROOT_DEV_BFCACHE_RELOAD}</Script>` block in `app/layout.tsx`.
- The unit test at `tests/unit/root-layout-bfcache.test.ts`.

The Playwright test at `tests/e2e/playwright/back-forward-hydration.test.ts` should be kept regardless, but its dev-mode branch (asserting `navigation.type === 'reload'`) would flip to the prod-mode assertion (`navigation.type !== 'reload'`) once the workaround is gone.

## Decision: Filing an Upstream Issue

**Decision:** DEFERRED.

Per `45-CONTEXT.md` `## Decisions` and `## Deferred Ideas`, filing an upstream Next.js issue is OPTIONAL: "Filing an upstream Next.js issue with a minimal repro is allowed but optional." `## Deferred Ideas` reinforces: "Filing and shepherding an upstream Next.js PR — kept optional for Phase 45; if the root-cause investigation surfaces a clean fix in <2h of additional effort, attempt it; otherwise defer."

The root cause was not isolated within the 4-hour time budget. Without an isolated minimal repro, an upstream issue would amount to "client-component-heavy page on Next.js 16.2.2 dev mode loses Flight payload on back/forward" — which is approximately what the two closest existing reports (the streaming-RSC soft-nav stuck issue and the bfcache + App Router router cache inconsistency issue, both linked above) already describe at higher resolution. Filing a fifth slightly-different report is unlikely to drive movement.

The decision will be revisited if the bug persists in Next.js 16.3+ or if a future investigation surfaces a minimal repro that clearly differentiates this case from the existing five. Until then, the workaround is durable, has zero production cost, and is well-understood.

## Test Coverage

- **Unit test:** `tests/unit/root-layout-bfcache.test.ts` (created in plan 45-04). Source-read assertions on `app/layout.tsx`: confirms the `<Script>` element exists, is gated on `NODE_ENV`, uses the `back_forward` detection contract, calls `window.location.reload()`, has the stable `root-dev-bfcache-reload` id, and uses `strategy="beforeInteractive"`. Also asserts the per-page workaround was deleted from `app/hub/layout.tsx`.
- **E2E test:** `tests/e2e/playwright/back-forward-hydration.test.ts` (created in plan 45-05). Dual-mode test driven by `NEXT_BUILD_MODE` env var: dev mode (`pnpm dev`) asserts `navigation.type === 'reload'` after a `page.goBack()` on `/hub` and `/billing` (workaround fired); prod mode (`NEXT_BUILD_MODE=production` -> `pnpm build && pnpm start`) asserts `navigation.type !== 'reload'` (clean rehydration without the workaround).
- **Cross-browser:** Chromium-only in CI per `45-CONTEXT.md` (matches existing `tests/e2e/playwright/playwright.config.ts` chromium project). Firefox + WebKit are available via local opt-in (`pnpm exec playwright test --project=firefox --grep "back-forward"`). Cross-browser CI is explicitly deferred per `45-CONTEXT.md` `## Deferred Ideas`.

## Status

- **Date:** 2026-05-01.
- **Status:** Workaround shipped at root layout; per-page workaround deleted; root cause unisolated within the time budget; upstream issue filing deferred.
- **Owner:** Phase 45 root-layout fix commit `06c1867f` (`feat(45): lift dev-only bfcache reload Script to root layout`) on branch `feature/v1.11-phase-42-foundations`. Companion commits: `d4e61a36` (per-page deletion), `30a05ad0` (replacement unit test), `554e7d93` + `84d1eb4f` + `69063092` (dual-mode Playwright wiring + scripts + e2e suite), `2df832d1` (this ADR).
- **Supersedes:** the per-page workaround in `app/hub/layout.tsx` introduced by commit `cef214f0` in Phase 43 (October 2025 era). The per-page `<Script>` block, the `HUB_DEV_BFCACHE_RELOAD` const, and the associated `tests/unit/hub-layout-bfcache.test.ts` have all been deleted; `app/hub/layout.tsx` is now a metadata-only passthrough that simply renders `<>{children}</>`.
- **Revisit trigger:** If Next.js 16.3+ ships a fix for any of the three streaming-RSC / bfcache / Turbopack-hydration issues catalogued in `## Bounding the Hypothesis Space`, re-test the bug signature on a clean `pnpm dev` instance. If the symptom is gone, delete the workaround per the file list in `## What Would Constitute a Real Upstream Fix`.
