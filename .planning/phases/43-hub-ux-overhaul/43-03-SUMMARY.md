---
phase: 43-hub-ux-overhaul
plan: 03
subsystem: ui
tags: [hub, tile, vote, accessibility, design-tokens, react, tailwind]

# Dependency graph
requires:
  - phase: 43-hub-ux-overhaul
    provides: Reserved-slug validator (43-01), tag route (43-02 — consumes the same tile)
provides:
  - Restructured WorkflowTemplateCard tile with no bottom-row buttons
  - Top-right vote cluster (left of Featured pill when both present)
  - CSS ::before pseudo-element click overlay routing tile body to onPreview
  - Hover states (border-accent + translate-y + shadow upgrade) per UI-SPEC
  - Token-backed vote arrows (no raw text-green-400 / text-red-400 palette refs)
  - Typography aligned to phase-43 Typography contract (font-medium banned)
affects: [43-05 (anonymous Use-template flow), 43-06 (List-view row mirrors tile contract), 43-09 (E2E coverage of tile-as-link), 44 (marketplace tile reuse)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tile-as-link via role='link' + onClick + onKeyDown + ::before overlay (NO wrapping <a>) — preserves nested-button accessibility"
    - "Layered z-index: ::before overlay z-[1], interactive content z-[2], pointer-events: none/auto choreography"
    - "Vote arrows e.stopPropagation() prevents bubbling to article-level onClick"

key-files:
  created: []
  modified:
    - components/hub/workflow-template-card.tsx

key-decisions:
  - "Used role='status' on the score <span> to satisfy WAI-ARIA spec (aria-label requires a role that supports it); plan grep test for aria-label.*Score still passes"
  - "Two biome-ignore comments added on the <article role='link'> pattern — UI-SPEC HUB-16 mandates this exact shape; wrapping <a> would invalidate nested vote buttons (a tag cannot contain interactive descendants)"
  - "isDuplicating and onDuplicate kept as @deprecated optional props so workflow-template-grid.tsx (caller) continues to compile without changes; plan 43-05 will rewire the anonymous Use-template flow"
  - "text-[10px] / text-[11px] arbitrary sizes normalized to text-[0.625rem] / text-[0.6875rem] per Typography contract"

patterns-established:
  - "Tile click target via ::before pseudo-element overlay — adopt for List-view row in 43-06"
  - "Vote arrows use --color-text-accent / --color-text-error tokens, never raw Tailwind palette"
  - "font-medium is BANNED in this phase — caption=font-normal, emphasis=font-semibold"

requirements-completed: [HUB-16, HUB-17]

# Metrics
duration: 4min
completed: 2026-04-30
---

# Phase 43 Plan 03: Restructure tile to top-right vote cluster + body click overlay Summary

**Tile is now tile-as-link: bottom-row Use Template / Preview / vote-arrows gradient overlay deleted; vote group sits in the top-right corner (left of Featured pill when both present); the entire tile body is the click target via a CSS `::before` pseudo-element overlay backed by `role="link"` + `onClick` + `onKeyDown` (no wrapping `<a>`).**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-30T11:17:17Z
- **Completed:** 2026-04-30T11:21:08Z
- **Tasks:** 1 / 1
- **Files modified:** 1

## Accomplishments

- Bottom-row gradient overlay (Use Template + Preview + bottom VoteButtons) deleted from `components/hub/workflow-template-card.tsx`
- Vote cluster relocated to top-right; renders as `[↑ N ↓] [★ Featured]` when both vote and Featured pill are present
- Tile body navigates to Preview via `::before` pseudo-element overlay (`z-[1]`), with vote arrows + Featured pill at `z-[2]` and `pointer-events-auto`
- Hover states wired: `hover:-translate-y-[2px]`, `hover:shadow-md`, `hover:border-[var(--color-border-accent)]` over `transition-all duration-150 ease motion-reduce:transition-none`
- Color migration: `text-green-400` / `fill-green-400` / `text-red-400` / `fill-red-400` (4 occurrences, all in `voteColorClass()` / `scoreColorClass()` / `VoteButtons`) replaced with `--color-text-accent` / `--color-text-error` token references
- Typography contract enforced: 3 instances of `font-medium` removed (replaced with `font-semibold` for emphasis-grade vote count, `font-normal` for caption-grade Featured pill text + tag pills); `text-[10px]` / `text-[11px]` normalized to `text-[0.625rem]` / `text-[0.6875rem]`
- `onDuplicate` and `isDuplicating` props marked `@deprecated` and made optional — caller (`workflow-template-grid.tsx`) continues to compile unchanged
- Hardcoded `text-[#0a0f14]` removed (it was on the deleted "Use Template" inline button)

## Task Commits

1. **Task 1: Restructure tile component (top-right vote cluster + ::before click overlay + hover states + token migration)** — `ea09306f` (feat)

_(Plan-level commit appended after SUMMARY.md / STATE.md / ROADMAP.md update — see final commit at bottom of execution.)_

## Files Created/Modified

- `components/hub/workflow-template-card.tsx` — full restructure: bottom-row deleted (~25 lines removed), top-right vote cluster + click overlay added (~30 lines added), token migration across the file. Net: 73 insertions, 81 deletions.

### Lines deleted (bottom-row gradient overlay)

- The entire `<div className="pointer-events-none absolute inset-0 ...">` gradient block (previously lines 188–211): contained the inline "Use Template" button (`bg-[var(--color-text-accent)] text-[#0a0f14]`), the inline "Preview" button (`Eye` icon + label), and the bottom-row `<VoteButtons />`.
- The pre-tile inline-score row (`{score !== 0 && <div className="flex h-[20px] ...">`) on the previous lines 121–132 — this was the duplicate score readout above the tile that became redundant once the vote cluster moved into the header row.
- Imports: `Copy` and `Eye` icons removed (no longer referenced).

### Lines added (top-right vote cluster + click overlay)

- New `VoteCluster` component replacing the bottom-row `VoteButtons`: renders inline in the top-right header cluster, uses `--color-text-accent` / `--color-text-error` tokens, includes `aria-label="Score {N}"` on the score span (with `role="status"`), preserves `e.stopPropagation()` on each arrow click.
- New `voteCountColorClass()` helper replacing the deleted `voteColorClass()` / `scoreColorClass()` (the latter was only consumed by the deleted inline-score row).
- New `<article>` shell with `role="link"`, `tabIndex={0}`, `aria-label="Open {workflowName} preview"`, `onClick`, and `onKeyDown` (Enter / Space activates).
- New CSS overlay: `before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:content-['']`.
- New hover states: `hover:-translate-y-[2px]`, `hover:shadow-md`, `hover:border-[var(--color-border-accent)]`, `focus-within:ring-2 focus-within:ring-[var(--color-border-accent)]`.
- Inner content `<div>` is `pointer-events-none relative z-[2]` so the ::before overlay catches stray clicks; vote cluster + Featured pill cluster + tag-pills row each set `pointer-events-auto` to remain interactive.

### Token migrations performed (raw palette → semantic tokens)

| Before | After | Site |
|---|---|---|
| `text-green-400` | `text-[var(--color-text-accent)]` | upvote-active arrow color, score color when upvoted |
| `fill-green-400` | `fill-[var(--color-text-accent)]` | upvote-active arrow fill |
| `text-red-400` | `text-[var(--color-text-error)]` | downvote-active arrow color, score color when downvoted |
| `fill-red-400` | `fill-[var(--color-text-error)]` | downvote-active arrow fill |
| `text-[#0a0f14]` | (removed with the deleted Use Template inline button) | n/a |
| `text-[10px]` | `text-[0.625rem]` | Featured pill text, tag pills, +N overflow pill |
| `text-[11px]` | `text-[0.6875rem]` | Vote count (top-right cluster) |
| `font-medium` (×3) | `font-semibold` (vote count, emphasis) / `font-normal` (Featured pill text, tag pills, captions) | typography role table |

Token-audit delta: errors 8 → 6 (the two `#0a0f14` hex literals on the deleted inline Use Template button are gone), warnings 75 → 72.

## Decisions Made

- **`role="status"` on the score span:** WAI-ARIA `aria-label` is not supported on a bare `<span>`. Adding `role="status"` makes the attribute valid AND keeps the screen-reader experience faithful to UI-SPEC ("Tile vote count visually-hidden context: `aria-label="Score {N}"`"). The `role="status"` polite-live-region semantic is appropriate for a value that updates after a vote round-trip.
- **Two `biome-ignore` comments on the `<article role="link">` shape:** the lint rules `lint/a11y/noNoninteractiveElementToInteractiveRole` and `lint/a11y/useSemanticElements` would force replacing `<article>` with `<a>` or `<div>`. UI-SPEC HUB-16 explicitly mandates `<article role="link">` because (a) the tile is semantically an article (workflow card with name + description + visualization + tags), (b) wrapping in `<a>` would make the nested vote `<button>` elements invalid descendants per HTML5 spec ("a element must not contain interactive descendants"). Both ignores include rationale citing UI-SPEC HUB-16.
- **`onDuplicate` and `isDuplicating` retained as `@deprecated` optional props:** the caller (`components/hub/workflow-template-grid.tsx`) still passes both. Plan 43-05 will rewire the anonymous Use-template flow; until then keeping the props prevents an unrelated grid refactor inside this plan's scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `role="status"` to the score `<span>`**

- **Found during:** Task 1 verification (running biome lint)
- **Issue:** `lint/a11y/useAriaPropsSupportedByRole` flagged `<span aria-label="Score {N}">` — bare `<span>` has no implicit role and therefore does not support `aria-label` per the WAI-ARIA spec.
- **Fix:** Added `role="status"` on the score span. This satisfies the lint rule, keeps the `aria-label` valid, and matches the UI-SPEC intent of providing screen-reader context for the numeric value.
- **Files modified:** `components/hub/workflow-template-card.tsx`
- **Verification:** `node_modules/.bin/biome check components/hub/workflow-template-card.tsx` exits clean; grep test `aria-label.*Score == 1` still passes.
- **Committed in:** `ea09306f`

**2. [Rule 3 - Blocking] Added two `biome-ignore` comments to preserve UI-SPEC HUB-16 contract**

- **Found during:** Task 1 verification (running biome lint)
- **Issue:** `lint/a11y/useSemanticElements` and `lint/a11y/noNoninteractiveElementToInteractiveRole` both flagged `<article role="link">`. The lint rules' suggested fixes (replace `<article>` with `<a>` or remove `role="link"`) directly contradict UI-SPEC HUB-16's binding requirement and would either break nested-button accessibility (anchor-with-buttons) or strip the element of its accessible name and role.
- **Fix:** Added two scoped `biome-ignore` comments — one above `<article>` for `useSemanticElements`, one immediately above `role="link"` for `noNoninteractiveElementToInteractiveRole` — each with rationale citing UI-SPEC HUB-16.
- **Files modified:** `components/hub/workflow-template-card.tsx`
- **Verification:** `node_modules/.bin/biome check components/hub/workflow-template-card.tsx` exits clean (0 errors, 0 warnings on this file).
- **Committed in:** `ea09306f`

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking lint failures that prevented the plan-mandated structure from passing pre-commit). Both deviations are necessary for accessibility correctness and CLAUDE.md compliance (lint must pass before commit). No scope creep.

**Impact on plan:** Zero scope expansion. Both fixes preserve the binding UI-SPEC HUB-16 contract; the `role="status"` addition is a strict enhancement over the plan's minimal `aria-label` because it makes the live-region semantics explicit.

## Issues Encountered

- **`pnpm check` blocked by ultracite/pnpm minimum-release-age constraint:** `ultracite check` invocation via `pnpm check` failed because pnpm refused to install `@biomejs/biome@2.4.13` (released 6 days ago) under its `minimumReleaseAge` setting. Worked around by invoking the locally-installed binary directly (`node_modules/.bin/biome check ...`) — biome 2.4.10 is in `package.json` and the `node_modules/@biomejs/biome` directory exists. The pre-commit hook also relies on `pnpm check`, but the commit still succeeded because the project's pre-commit script (`.claude/hooks/pre-commit-checks.sh`) invokes `pnpm check` which falls through gracefully when the dlx-fetched binary fails to install (it caches the prior run's output). Lint correctness was independently verified via the local biome binary. Recommendation for plan 43-04: same workaround applies; long-term fix is to either pin `@biomejs/cli-darwin-arm64` in `minimumReleaseAgeExclude` or wait until biome 2.4.13 ages past the threshold.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The tile contract is now stable for plan 43-04 (Use-template CTA rename + restyle in workflow Preview/detail toolbar) and plan 43-05 (anonymous Use-template flow rewiring in `workflow-template-grid.tsx`).
- The grid (`components/hub/workflow-template-grid.tsx`) was deliberately untouched; it still calls `onDuplicate` and `isDuplicating`, both now `@deprecated` optional props on the tile. Plan 43-05 will replace the grid's anonymous-signup fallback with the Phase-42 `useAuthPrompt` flow.
- Plan 43-06 (List view row) should adopt the same `::before` overlay + `role="link"` + `onKeyDown` pattern established here.
- HUB-16 and HUB-17 are now complete in code; E2E coverage (tile click navigates to `/workflows/{id}`, vote arrows do not bubble to body click, focus-within ring on keyboard focus) is owned by plan 43-09.

## Self-Check: PASSED

- `[x] FOUND: components/hub/workflow-template-card.tsx` (modified, 73 insertions / 81 deletions in commit ea09306f)
- `[x] FOUND: ea09306f` (`git log --oneline | grep ea09306f` returns the commit)
- `[x] FOUND: .planning/phases/43-hub-ux-overhaul/43-03-SUMMARY.md` (this file)
- `[x] grep checks all pass:` `before:absolute before:inset-0`==1, `before:z-[1]`==1, `z-[2]`==2, raw palette refs==0, `font-medium`==0, Use Template / Preview labels==0, `aria-label.*Score`==1, `role="link"` JSX attr==1 (grep matches 2 because biome-ignore comment string also contains it), hover translate/shadow/border each==1, `motion-reduce:transition-none`==5
- `[x] tsc --noEmit` exits 0
- `[x] node_modules/.bin/biome check` on the modified file exits 0
- `[x] node scripts/token-audit.js` exits 0; the modified file contributes 0 errors and 4 warnings (3 plan-mandated `z-[1]/z-[2]` + 1 pre-existing `h-[20px]` on the Featured pill)

---
*Phase: 43-hub-ux-overhaul*
*Completed: 2026-04-30*
