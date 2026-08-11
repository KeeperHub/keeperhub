Write a new Playwright E2E test using the discovery-first workflow.

## Arguments

$ARGUMENTS should describe what the test should verify. Example: `"user can create a scheduled workflow"` or `"invitation flow sends email"`.

## Instructions

Follow this exact workflow. Do NOT write selectors from memory or guessing.

### Step 1: Identify target pages

Determine which pages/routes the test will interact with based on the test description.

### Step 2: Discover page structure

Run the discovery CLI for each relevant page:

```bash
pnpm discover <path> --auth --highlight
```

For example:
- Landing page: `pnpm discover / --auth`
- Workflow editor: `pnpm discover /workflow/<id> --auth --highlight`

If multi-step exploration is needed:
```bash
pnpm discover / --auth --steps "click:button:has-text('New Workflow')" "probe:after-click"
```

### Step 3: Read discovery output

Read the generated `elements.md` files from `tests/e2e/playwright/.probes/`. These contain:
- Verified selectors for all interactive elements
- Element state (visible, disabled, why disabled)
- Accessibility tree for getByRole/getByLabel locators
- Page structure (headings, landmarks, dialogs, forms)

### Step 4: Check existing utilities

Before writing helper functions, check what already exists:

1. Read `tests/e2e/playwright/utils/auth.ts` for auth helpers:
   - `signUpAndVerify(page)`, `signIn(page, email, pw)`, `signOut(page)`
2. Read `tests/e2e/playwright/utils/workflow.ts` for workflow helpers:
   - `createWorkflow(page)`, `addActionNode(page, label)`, `saveWorkflow(page)`
3. Read `tests/e2e/playwright/utils/db.ts` for database helpers:
   - `createTestWorkflow(email)`, `createApiKey()`, `PERSISTENT_TEST_USER_EMAIL`

### Step 5: Write the test

Create the test file with these requirements:

1. **Import from fixtures, not @playwright/test**:
   ```typescript
   import { expect, test } from "./fixtures";
   // or for happy-paths/:
   import { expect, test } from "../fixtures";
   ```

2. **Use verified selectors** from `elements.md` -- never guess.

3. **Use existing utilities** where possible instead of reimplementing.

4. **Follow project conventions**:
   - `test.describe.configure({ mode: "serial" })` for tests with shared state
   - Regex patterns at top level (not inline)
   - Use `getByRole`, `getByLabel`, `locator('[data-testid="..."]')` in preference order
   - Use `expect(locator).toBeVisible({ timeout: X })` instead of `waitForSelector`

5. **No arbitrary waits** -- use `expect` with timeouts or `waitForLoadState`.

6. **Keep tests independent** when possible. Each test should set up its own state.

### Step 6: Run the test

```bash
pnpm test:e2e --grep "<test name>" 2>&1 | tee .claude/test-debug-output.txt
```

### Step 7: Fix failures using probe data

On failure, the custom fixture auto-captures diagnostics to `.probes/FAILURE-*`.

1. Read the FAILURE probe artifacts (elements.md, console-logs.txt, network-failures.txt)
2. Fix using verified data from probes
3. Re-run (max 3 attempts)

If the test still fails after 3 attempts, report what the probe data shows and stop.

### Rules

- ALWAYS discover before writing. No exceptions.
- NEVER use selectors not verified by discovery output.
- NEVER add `page.waitForTimeout()` except in rare timing-critical transitions (and document why).
- Tests importing from `./fixtures` get auto-probe on failure for free.
- Use `probe(page, "label")` inside tests for manual state capture during debugging.
- For authenticated tests, the `storageState` from `auth.setup.ts` is injected automatically by the `chromium` project config.
