# E2E Test Writing Patterns

This file supplements the root CLAUDE.md with E2E-specific patterns. All root CLAUDE.md rules still apply.

## Discovery-First Workflow

Before writing any test, use discovery tools to understand the page structure.

### CLI Discovery

```bash
# Unauthenticated page recon
pnpm discover /

# Authenticated page recon (uses persistent test user)
pnpm discover / --auth

# With numbered element overlays on screenshot
pnpm discover / --auth --highlight

# Multi-step exploration (click then probe)
pnpm discover / --auth --steps "click:button:has-text('New Workflow')" "probe:after-click"
```

Output goes to `tests/e2e/playwright/.probes/<label>-<timestamp>/`:
- `screenshot.png` -- full page screenshot
- `screenshot-highlighted.png` -- elements with numbered overlays (if --highlight)
- `elements.md` -- interactive elements table grouped by region
- `report.json` -- full structured data
- `summary.txt` -- compact overview

### In-Test Probing

```typescript
import { probe, highlightElements } from "./utils/discover";

test("my test", async ({ page }) => {
  await page.goto("/");
  await probe(page, "initial");           // captures screenshot + element map

  await page.click('button:has-text("Sign In")');
  await probe(page, "dialog-open");       // captures new state after click
});
```

### Structured Element Data

```typescript
import { getInteractiveElements, getPageStructure } from "./utils/discover";

// Get interactive elements (buttons, links, inputs)
const elements = await getInteractiveElements(page);

// Get page structure (headings, landmarks, forms)
const structure = await getPageStructure(page);
```

### Exploration Test Harness

`explore.test.ts` is a scratchpad for iterative exploration:

1. Edit the exploration steps
2. Run: `pnpm test:e2e --grep "explore"`
3. Read probe outputs from `.probes/`
4. Edit steps based on findings
5. Write the real test in a new file once page structure is understood

## Key Selectors Reference

| Element | Selector |
|---|---|
| Sign In button | `button:has-text("Sign In")` (first) |
| Auth dialog | `[role="dialog"]` |
| Signup email | `#signup-email` |
| Signup password | `#signup-password` |
| OTP input | `#otp` |
| User menu | `[data-testid="user-menu"]` |
| Workflow canvas | `[data-testid="workflow-canvas"]` |
| Trigger node | `.react-flow__node-trigger` |
| Action grid | `[data-testid="action-grid"]` |
| Add Step button | `button[name="Add Step"]` |
| Toasts | `[data-sonner-toast]` |
| Org switcher | `button[role="combobox"]` |

## Test Utilities

| Utility | Import | Purpose |
|---|---|---|
| `signUpAndVerify(page)` | `./utils/auth` | Full signup + OTP verification flow |
| `signUp(page)` | `./utils/auth` | Signup without OTP verification |
| `signIn(page, email, pw)` | `./utils/auth` | Sign in with existing credentials |
| `createWorkflow(page)` | `./utils/workflow` | Navigate + create new workflow |
| `addActionNode(page, label)` | `./utils/workflow` | Add action node to canvas |
| `waitForCanvas(page)` | `./utils/workflow` | Wait for workflow canvas to load |
| `probe(page, label)` | `./utils/discover` | Capture page state for analysis |
| `highlightElements(page)` | `./utils/discover` | Add numbered overlays to elements |
| `getInteractiveElements(page)` | `./utils/discover` | Get structured element list |
| `getPageStructure(page)` | `./utils/discover` | Get page headings, landmarks, forms |
| `createTestWorkflow(email)` | `./utils/db` | Inject workflow directly into DB |

## Test Structure Patterns

### Auth Setup

Tests requiring authentication use persistent auth state from `auth.setup.ts`. The setup runs once and stores browser state in `tests/e2e/playwright/.auth/`.

```typescript
import { test, expect } from "@playwright/test";

// Tests in files that use the "authenticated" project automatically
// get the persistent test user's session from auth.setup.ts
```

### Standard Test Anatomy

```typescript
import { test, expect } from "@playwright/test";

test.describe("Feature Name", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/target-page", { waitUntil: "domcontentloaded" });
  });

  test("should do expected behavior", async ({ page }) => {
    // Wait for key element
    await page.waitForSelector('[data-testid="target"]', {
      state: "visible",
      timeout: 15_000,
    });

    // Interact
    await page.click('button:has-text("Action")');

    // Assert
    await expect(page.locator('[data-testid="result"]')).toBeVisible();
    await expect(page.locator('[data-testid="result"]')).toHaveText("Expected");
  });
});
```

### Waiting Strategies

- `waitForSelector(selector, { state: "visible", timeout })` -- wait for element visibility
- `waitUntil: "domcontentloaded"` -- use on `page.goto()` for faster navigation
- `waitUntil: "networkidle"` -- use when page needs all network requests to finish
- `expect(locator).toBeVisible({ timeout })` -- assertion-based waiting
- `page.waitForTimeout(ms)` -- avoid unless waiting for animations or server-side hooks

### Assertion Patterns

```typescript
// Visibility
await expect(page.locator(selector)).toBeVisible({ timeout: 10_000 });
await expect(page.locator(selector)).toBeHidden();

// Text content
await expect(page.locator(selector)).toHaveText("exact text");
await expect(page.locator(selector)).toContainText("partial");

// Count
await expect(page.locator(selector)).toHaveCount(3);

// URL
await expect(page).toHaveURL(/\/dashboard/);
```

## Configuration

Key settings from `playwright.config.ts`:

- Base URL: `http://localhost:3000`
- Test timeout: 60 seconds
- Auth state directory: `tests/e2e/playwright/.auth/`
- Probe output: `tests/e2e/playwright/.probes/`

### Running Tests

```bash
pnpm test:e2e                          # All E2E tests
pnpm test:e2e --grep "pattern"         # Tests matching pattern
pnpm test:e2e --grep "explore"         # Run exploration harness
pnpm test:e2e tests/e2e/playwright/workflow.test.ts  # Specific file
```

The dev server must be running at `http://localhost:3000` before running E2E tests.
