# Phase 44: Unified Tabbed Hub (Protocols / Workflows / Marketplace) - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the current `/hub` layout with a unified, tabbed discovery surface that consolidates Protocols, Workflows, and Marketplace under one route. Tab navigation follows the ClawHub Skills/Plugins pattern: instant tab switch with no shell re-mount, URL updates per tab so deep links and browser history work. Drop the standalone Protocols strip and the "Templates" header/divider that exist today; Protocols become full cards inside their own tab. Rename the page hero away from "Web3 Workflow Templates" to copy that reflects all three surfaces. Marketplace tab is the popularity-sorted leaderboard, surfaced consistently to humans (UI tab) and agents (`/api/mcp/workflows?sort=` + `search_workflows` `sort` param) — without leaking any per-creator USDC figure or wallet address.

Out of scope: a standalone `/marketplace` route (explicitly forbidden by ROADMAP success #8 + reworded MARKET-01); cross-tab "Listed in marketplace" badges on Workflows-tab cards or rows (HUBV2-08 + MARKET-10 SUPERSEDED); earnings sort on the Marketplace ladder (deferred to v1.11.x or v1.12 per MARKET-02 + MARKET-FUTURE-01); per-row vote button on Marketplace rows (deferred per MARKET-FUTURE-04); collapsing the existing `/hub/tags/[tag]` deep-link route into a tab (the tag route stays top-level — Phase 43 contract preserved).

</domain>

<decisions>
## Implementation Decisions

### Tab Mechanics & URL Contract
- Tab implementation: Radix UI `<Tabs>` via the existing shadcn wrapper at `components/ui/tabs.tsx`. Zero new npm dependencies (locked in STATE.md decisions).
- URL convention: query param `?tab=protocols|workflows|marketplace`. Preserves the `/hub` route, keeps `/hub/tags/[tag]` deep-link contract intact, no migration of existing inbound links.
- URL update on tab click: `router.replace(url, { scroll: false })`. Each tab change replaces the current history entry rather than pushing a new one — keeps the back-button stack tight while still letting the browser back gesture step out of the tab strip into the previous page (matches ROADMAP success #1 "browser back button steps tab-by-tab" interpretation: stepping tab-by-tab applies WITHIN the tab strip via the History Replace API + `popstate` listener; stepping OUT of `/hub` returns to the previous route, not to a chain of intra-tab history entries).
- **Default tab when `?tab=` is absent: PROTOCOLS** — first in visual order. **OVERRIDES HUBV2-01 default-tab clause and ROADMAP success #1 default of "Workflows"**. Rationale: user accept during smart-discuss area 1 / Q4, 2026-05-01. REQUIREMENTS.md HUBV2-01 will be updated to match this decision.

### Marketplace Tab — Data Flow & Cache
- Marketplace tab content: server component `app/hub/_marketplace-tab.tsx` (underscore-prefix matches the Phase 43 `_view-shell.tsx` pattern). Runs the Drizzle GROUP-BY join on `workflows ⋈ workflow_payments` directly inside `unstable_cache`. Streams the table HTML to the tab content area without a client-side fetch hop.
- Cache TTL: `unstable_cache` 300s + response `Cache-Control: s-maxage=300, stale-while-revalidate=60`. Matches MARKET-05 spec verbatim. Rank can drift up to 5 minutes; acceptable per MARKET-02 popularity-only design.
- Pagination: `LIMIT 50` + cursor on `(callCount DESC, workflowId)` tiebreaker. Cursor is `(lastCallCount, lastWorkflowId)` base64-encoded, exposed as `?cursor=` query param on the marketplace tab. No offset-based pagination.
- Composite DB index on `workflow_payments`: add `(workflow_id, settled_at)` via Drizzle migration AFTER reviewing `EXPLAIN ANALYZE` output on the GROUP-BY plan. If the existing index already covers the plan, mark the migration as a no-op note in the SUMMARY rather than committing an empty migration. Matches MARKET-09 spec.

### Hero Copy & Left-Nav Strategy
- Hero headline: **"Hub"**. Sub: **"Browse protocols, fork community workflows, and discover paid services on the marketplace."** — short, names all three tabs, drops the "fork in one click" pitch. Final wording is the binding contract for HUBV2-07.
- Tone: factual, matches existing copy register; aligns with the user-saved "List/Listed not Publish/Published" preference (precision over flair).
- Tab labels: full names — **"Protocols" / "Workflows" / "Marketplace"** — matches REQUIREMENTS.md exact wording.
- Left-nav strategy (MARKET-11): single **"Hub"** entry that lands on `/hub?tab=protocols` (the new default). Marketplace surfaced via the tab strip alone — no secondary "Marketplace" link in the sidebar. Matches HUBV2-08 ("tab strip is the cross-tab discovery mechanism").

### Migration of Existing /hub & Frontend-Design Application
- Workflows-tab content lifts the body of `app/hub/_view-shell.tsx` and `app/hub/page.tsx` into a new `app/hub/_workflows-tab.tsx` server component, rendered inside the Workflows tab body. The existing `app/hub/tags/[tag]/page.tsx` deep-link route stays at top-level — it is not a tab; it's a tag-filtered Workflows view that bypasses the tab shell. Phase 43 contracts (sidebar Sort+Tags moved into sidebar, Cards/List view toggle, `hub_view` cookie, scroll preservation, Use-template CTA, `pending_template` cookie + PendingTemplateRunner) move into `_workflows-tab.tsx` UNCHANGED — no regression on any Phase 43 success criterion (HUBV2-06 contract).
- Protocols-tab content: new `app/hub/_protocols-tab.tsx` server component that fetches the same protocol data the existing `_view-shell.tsx` Protocols strip uses, rendered as a responsive card grid (image + name + tagline + workflow count per HUBV2-04). New `components/hub/protocol-card.tsx` mirroring `components/hub/workflow-template-card.tsx` shape. Clicking opens the existing protocol detail modal (no behavior regression).
- Apply `/frontend-design:frontend-design` skill during planning — STATE.md v1.11 decision says Phase 43 + Phase 44 both require it. The planner agent invokes the skill before writing UI plans for the tab strip, Protocols card grid, and Marketplace row template.
- Generate `44-UI-SPEC.md` via `gsd-ui-phase 44` BEFORE the planner runs — Phase 44 has heavy UI surface (tab strip, Protocols card grid, Marketplace leaderboard, hero rewrite). The locked visual contract feeds the planner so plans reference a single source of truth.

### Claude's Discretion
- Exact JSX structure of the tab strip (Radix Tabs wrapper variants).
- Specific color tokens for the active vs inactive tab pill (must come from `tokens.css` per CLAUDE.md design-system rules).
- Whether the per-tab content area uses `<Suspense>` boundaries for streaming or a single non-streaming render (must satisfy HUBV2-02 "no skeleton flicker on the surrounding shell").
- Exact column widths and row spacing in the Marketplace leaderboard table.
- Whether the tab strip search bar (per ROADMAP success #1) is rendered or deferred to a future sub-phase — the ROADMAP says "search bar visible alongside the tab strip" but search across all three surfaces is non-trivial; planner may defer if the search wiring exceeds the phase scope.
- Whether the existing Phase-43 marketplace-badge slot in `workflow-template-row.tsx` is left as a comment marker (HUBV2-08) or removed entirely.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `components/ui/tabs.tsx` — shadcn Radix Tabs wrapper, already in repo. The tab shell uses this.
- `app/hub/_view-shell.tsx` — Phase 43 server component holding the existing /hub view. Body lifts into `_workflows-tab.tsx`.
- `app/hub/page.tsx` — currently the server component that reads cookies and renders `_view-shell.tsx`. Becomes the tab-shell host that renders `<Tabs>` + tab content selectors.
- `app/hub/tags/[tag]/page.tsx` — Phase 43 deep-link route. Stays top-level; not a tab.
- `components/hub/workflow-template-card.tsx` — pattern reference for `components/hub/protocol-card.tsx`.
- `components/hub/workflow-template-row.tsx` — has the Phase 43 marketplace-badge slot comment marker; marker stays per HUBV2-08.
- `lib/db/schema-*.ts` (workflows, workflow_payments) — SELECT target for the Marketplace aggregate query.
- `unstable_cache` from `next/cache` — used by Phase 43's metadata routes; same pattern reused for the Marketplace cache.
- `app/api/mcp/workflows/route.ts` — existing MCP endpoint extended with `?sort=popular|recent` per MARKET-07.
- `lib/mcp/tools/search-workflows.ts` (or equivalent) — existing `search_workflows` MCP tool gains a `sort` parameter per MARKET-08.

### Established Patterns
- Server component + underscore-prefix client islands (`_view-shell.tsx` from Phase 43) — applied to `_protocols-tab.tsx`, `_workflows-tab.tsx`, `_marketplace-tab.tsx`.
- Cookies-as-state for view preferences (`hub_view` from Phase 43, `pending_template` from Phase 43-05). The new `?tab=` lives in the URL, not a cookie — tab choice is intentional per-navigation, not a sticky preference.
- Drizzle migrations co-located with the schema change in `drizzle/`. The composite-index migration follows the same pattern.
- Design tokens from `specs/design-system/tokens.css` only — no hardcoded hex. Token-audit script gates the commit.
- React 19 `useTransition` + `router.push|replace` for navigation that preserves scroll (Phase 43-13 pattern).

### Integration Points
- `app/hub/page.tsx` — root host; reads `?tab=` from `searchParams`, branches to one of three tab content components.
- `app/hub/_workflows-tab.tsx` (new) — receives the lifted Phase 43 view content.
- `app/hub/_protocols-tab.tsx` (new) — full card grid.
- `app/hub/_marketplace-tab.tsx` (new) — server component with the cached aggregate query.
- `components/hub/protocol-card.tsx` (new).
- `components/hub/marketplace-row.tsx` (new) — leaderboard row.
- `app/api/mcp/workflows/route.ts` — MARKET-07 extension.
- `lib/mcp/tools/search-workflows.ts` — MARKET-08 extension.
- `drizzle/` — composite-index migration, conditional on EXPLAIN ANALYZE result.
- `components/navigation-sidebar.tsx` — single Hub entry, no secondary Marketplace link.
- `tests/e2e/playwright/` — new test for tab switching, deep linking, marketplace privacy filtering, no-cross-tab-badge contract.

</code_context>

<specifics>
## Specific Ideas

- ClawHub Skills/Plugins is the visual reference (pill-shaped active tab with icon, semi-transparent inactive tabs). Find a public screenshot or current ClawHub URL during the UI-SPEC step.
- The Marketplace tab leaderboard rendered HTML must surface ZERO occurrences of `creatorWalletAddress`, `userId`, `organizationId`, `payerAddress`, or precise `amountUsdc`. The MARKET-13 Playwright test asserts this directly via `page.content()` grep.
- The page hero is now "Hub" / "Browse protocols, fork community workflows, and discover paid services on the marketplace." — locked.
- Phase 45's root-layout bfcache fix is now live; the tab-driven URL changes via `router.replace` should not trip the same hydration race, but the planner should still verify by exercising the back-forward Playwright test against `/hub?tab=...` URLs as a smoke check.

</specifics>

<deferred>
## Deferred Ideas

- Earnings sort + display on the Marketplace tab (MARKET-FUTURE-01) — pending privacy review and bucketing-threshold sign-off.
- Time-window filters (24h/7d/30d) on the Marketplace ladder (MARKET-FUTURE-02) — defer until popularity-only view has data + UX feedback.
- Materialized `workflow_stats` table (MARKET-FUTURE-03) — defer until `unstable_cache` proves insufficient at ~10k payments scale.
- Per-row vote button on Marketplace rows (MARKET-FUTURE-04) — currently Hub-only.
- Cross-tab "Listed in marketplace" badge on Workflows-tab cards (MARKET-10 SUPERSEDED by HUBV2-08) — revisit only if user feedback shows tab-strip discovery is insufficient.
- Search bar across all three tabs — ROADMAP success #1 mentions "search bar visible alongside the tab strip" but cross-tab search wiring is non-trivial; planner may defer to a future sub-phase if it exceeds the Phase-44 envelope.
- Subroute migration (`/hub/protocols`, `/hub/workflows`, `/hub/marketplace`) — query-param `?tab=` ships now; subroutes are a future cleanup if URL aesthetics matter.

</deferred>
