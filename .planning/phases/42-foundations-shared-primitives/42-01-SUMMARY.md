---
phase: 42-foundations-shared-primitives
plan: 01
subsystem: test-infrastructure
tags: [scaffolding, fixtures, vitest, playwright, wave-1]
requirements:
  completed: [TEST-01, TEST-02, TEST-03, SEC-06, MODAL-08, NAV-08]
key-files:
  created:
    - tests/unit/fixtures/workflow-import-valid.json
    - tests/unit/fixtures/workflow-import-passthrough-extras.json
    - tests/unit/fixtures/workflow-import-201-nodes.json
    - tests/unit/fixtures/workflow-import-non-https-webhook.json
    - tests/unit/fixtures/workflow-import-code-step-with-content.json
    - tests/unit/fixtures/workflow-import-oversize-payload.json
    - tests/unit/workflow-import-schema.test.ts
    - tests/e2e/playwright/workflow-io-modal.test.ts
    - tests/e2e/playwright/logged-out-nav.test.ts
metrics:
  duration: ~10m
  completed: 2026-04-30
---

# Phase 42 Plan 01: Test Scaffolding & Fixtures Summary

Wave 1 scaffolding for Phase 42: six deterministic JSON fixtures and three test skeletons that downstream plans (42-02 schema hardening, 42-09 test bodies) reference by exact path.

## What Shipped

- **Six fixtures in `tests/unit/fixtures/`** — one positive (`valid`) plus five rejection cases (`passthrough-extras`, `201-nodes`, `non-https-webhook`, `code-step-with-content`, `oversize-payload`). Each violates exactly one schema/route invariant for clean assertion targeting.
- **`tests/unit/workflow-import-schema.test.ts`** — Vitest skeleton, 6 `it()` blocks, each with a `TODO(42-09)` comment. Imports `workflowExportV1Schema` from `@/lib/workflow/export-schema`. Loads fixtures via `readFileSync` + `JSON.parse` using `import.meta.dirname`.
- **`tests/e2e/playwright/workflow-io-modal.test.ts`** — Playwright skeleton, 4 `test()` blocks for MODAL-04/05/06/08, plus `beforeEach`. Imports `signUpAndVerify` for plan 42-09 setup.
- **`tests/e2e/playwright/logged-out-nav.test.ts`** — Playwright skeleton, 5 `test()` blocks for NAV-01..05/08.
- **Lint & type-check** — `biome check` reports 0 errors and 0 warnings on the three new files. `pnpm type-check` (full repo `tsc --noEmit`) exits 0.

## Files Touched

Created 9 files. Zero existing files modified. Stayed strictly within `files_modified` from the plan frontmatter — did not touch `tests/unit/use-persisted-nav-state.test.ts` even though it appeared in `git status` (it belongs to a parallel Wave 1 plan, 42-05).

## Test Coverage Delta

- Vitest unit suite: **+1 file, +6 placeholder tests** (`tests/unit/workflow-import-schema.test.ts` — 6 passing). Target file run via `pnpm exec vitest run tests/unit/workflow-import-schema.test.ts`: 6/6 passed.
- Playwright e2e suite: **+2 files, +9 placeholder tests** (4 in modal file + 5 in logged-out-nav). Bodies are `expect(true).toBe(true)`; full bodies land in plan 42-09.
- TODO markers across all three test files: **16 total** (target was >= 14).

## Verification

| Acceptance criterion | Status |
| --- | --- |
| `tests/unit/fixtures/` directory exists | PASS |
| All six fixture files exist | PASS |
| Five non-oversize fixtures parse via `JSON.parse` | PASS |
| `wc -c oversize > 1153434` | PASS — 1,200,259 bytes |
| `201-nodes.json` has exactly 201 nodes | PASS |
| `non-https-webhook.json` contains `http://internal.example.com/admin` | PASS |
| `code-step-with-content.json` contains `code/run-code` | PASS |
| `passthrough-extras.json` has `secretKey` at node envelope | PASS |
| Unit test scaffold runs 6 passing tests | PASS |
| `biome check` against new files exits 0 | PASS |
| `pnpm type-check` exits 0 | PASS |
| TODO marker count >= 14 | PASS — 16 |

## Deviations from Plan

**Adjusted unused-symbol pattern.** The plan's example used `expect(true).toBe(true)` placeholder bodies plus imports referenced only by TODO comments. Biome's `lint/correctness/noUnusedImports` and `lint/complexity/noVoid` blocked both patterns. Adjusted to: (a) drop `async` from placeholder test callbacks (Playwright's `test()` accepts sync fns; plan 42-09 will re-add `async` when filling bodies), and (b) anchor each import with a single `expect(symbol).toBeDefined()` so imports are kept live without `void` discards. This preserves the plan's intent (skeletons compile + lint clean) while satisfying Ultracite/Biome rules. Filed under Rule 1 (auto-fix bugs / lint blockers).

**Used `import.meta.dirname` over `__dirname`.** Biome's `lint/correctness/noGlobalDirnameFilename` flagged `__dirname` (project is ESM under TS). Switched to `import.meta.dirname` per the auto-fix suggestion. Filed under Rule 1.

## Self-Check: PASSED

- All nine created files exist on disk: `tests/unit/fixtures/{workflow-import-valid,workflow-import-passthrough-extras,workflow-import-201-nodes,workflow-import-non-https-webhook,workflow-import-code-step-with-content,workflow-import-oversize-payload}.json`, `tests/unit/workflow-import-schema.test.ts`, `tests/e2e/playwright/{workflow-io-modal,logged-out-nav}.test.ts`.
- Plan-level `must_haves.truths` all hold (fixtures dir exists, six fixtures present, three test scaffolds with TODOs, every fixture parses).
- Plan-level `must_haves.artifacts` paths and `key_links` all match (vitest test imports schema by `@/lib/workflow/export-schema`; e2e modal test imports `signUpAndVerify` from `./utils/auth`; vitest test reads fixtures via `readFileSync`+`JSON.parse`).
