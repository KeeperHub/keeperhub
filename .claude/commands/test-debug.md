Debug a failing Playwright E2E test using the auto-probe diagnostic framework.

## Arguments

$ARGUMENTS should be the test file path or grep pattern for the failing test. Example: `tests/e2e/playwright/auth.test.ts` or `"user can sign in"`.

## Instructions

Follow this exact workflow. Do NOT guess at fixes without reading probe data first.

### Step 1: Run the failing test

```bash
pnpm test:e2e --grep "$ARGUMENTS" 2>&1 | tee .claude/test-debug-output.txt
```

If $ARGUMENTS is a file path, use `--project chromium` and the file path instead of `--grep`.

Read `.claude/test-debug-output.txt` to understand the failure.

### Step 2: Read failure diagnostics

On failure, the custom fixture auto-generates probe artifacts. Find and read them:

1. Look in `tests/e2e/playwright/.probes/` for directories starting with `FAILURE-`
2. Read the most recent FAILURE directory's files:
   - `elements.md` - what interactive elements were on the page at failure time
   - `console-logs.txt` - browser console output (errors, warnings, logs)
   - `network-failures.txt` - failed HTTP requests
   - `screenshot.png` - visual state of the page at failure
   - `summary.txt` - page title, URL, element counts

### Step 3: Classify the failure

Based on the probe data, classify the failure as one of:

| Category | Symptoms | Typical Fix |
|----------|----------|-------------|
| **Selector wrong** | Element not in elements.md, or locator differs | Use locator from elements.md |
| **Timing** | Element exists but test acts before visible/enabled | Add waitFor, increase timeout |
| **Server error** | 4xx/5xx in network-failures, error in console | Fix API or add retry |
| **Missing data** | Page loaded but expected content absent | Check DB seeding, auth state |
| **Auth expired** | Redirected to login, auth dialog visible | Re-run auth.setup, check storageState |
| **Page changed** | Elements exist but layout/flow differs from test | Update test to match current UI |

### Step 4: Apply fix

Using verified data from the probe artifacts (not guessing), apply the fix. Reference specific locators from `elements.md`.

### Step 5: Re-run to verify

Run the test again:

```bash
pnpm test:e2e --grep "$ARGUMENTS" 2>&1 | tee .claude/test-debug-output.txt
```

### Step 6: Iterate (max 3 attempts)

If it fails again, repeat Steps 2-5. After 3 failed attempts, stop and report:
- What you tried
- What the probe data showed each time
- Your best hypothesis for the root cause

### Rules

- NEVER guess selectors. Always read `elements.md` for verified selectors.
- NEVER add arbitrary `waitForTimeout()` as a fix. Use proper `waitFor` with conditions.
- If the page is in an unexpected state (wrong URL, auth dialog when authenticated), check `console-logs.txt` for errors first.
- If `network-failures.txt` shows API errors, the fix is likely server-side, not in the test.
- Clean up FAILURE probe directories after successfully fixing: `rm -rf tests/e2e/playwright/.probes/FAILURE-*`
