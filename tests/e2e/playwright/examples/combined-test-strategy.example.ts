// biome-ignore-all lint/suspicious/noSkippedTests: example file with intentionally skipped tests
// biome-ignore-all lint/correctness/noUnusedImports: example file with commented-out code
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: example file with commented-out code

/**
 * EXAMPLE: Combined Vitest + Playwright Testing Strategy
 *
 * This file demonstrates the pattern for E2E tests that need both:
 * - Playwright: UI interactions (browser automation)
 * - Vitest-style utilities: Backend operations (DB, API calls)
 *
 * STRUCTURE:
 * tests/
 * ├── utils/                    # SHARED utilities (both Vitest & Playwright can use)
 * │   └── db.ts                 # Database operations
 * ├── fixtures/                 # SHARED test fixtures
 * │   └── workflows.ts          # Workflow node/edge builders
 * ├── e2e/
 * │   ├── *.test.ts             # Vitest backend tests (no browser)
 * │   └── playwright/
 * │       ├── utils/
 * │       │   ├── auth.ts       # Playwright-specific (browser auth)
 * │       │   └── workflow.ts   # Playwright-specific (canvas interactions)
 * │       └── *.test.ts         # Playwright tests (browser + shared utils)
 *
 * RESPONSIBILITIES:
 * - Playwright: Sign up, navigate, fill forms, click buttons, visual assertions
 * - Shared utils: Create test data, DB queries, wait for execution, cleanup
 */

import { expect, test } from "@playwright/test";

// ============================================================================
// SHARED UTILITIES (can be used by both Vitest and Playwright)
// These would live in tests/utils/db.ts
// ============================================================================

// import {
//   createApiKey,
//   createTestWorkflow,
//   deleteApiKey,
//   deleteTestWorkflow,
//   getWorkflowWebhookUrl,
//   waitForWorkflowExecution,
// } from "../../../utils/db";

// ============================================================================
// PLAYWRIGHT-SPECIFIC UTILITIES (browser interactions only)
// These live in tests/e2e/playwright/utils/
// ============================================================================

// import { signUpAndVerify } from "../utils/auth";
// import { waitForCanvas, openWorkflow } from "../utils/workflow";

// ============================================================================
// EXAMPLE TEST: Webhook Workflow E2E
// Shows how Playwright and shared utilities work together
// ============================================================================

test.describe("Example: Combined Test Strategy", () => {
  test.skip("webhook workflow - full E2E test", async ({
    page,
    request,
    baseURL,
  }) => {
    // ========================================================================
    // STEP 1: PLAYWRIGHT - User signs up via browser
    // ========================================================================
    // Playwright handles all UI interactions:
    // - Navigate to homepage
    // - Click sign in button
    // - Fill form fields
    // - Submit form
    // - Verify OTP (reads OTP from DB using shared utils)
    // const { email } = await signUpAndVerify(page);
    // At this point, the user exists in the database with an organization
    // ========================================================================
    // STEP 2: SHARED UTILS - Create test data in database
    // ========================================================================
    // Backend utilities inject data directly into DB:
    // - Create workflow with properly connected nodes/edges
    // - Create API key for webhook authentication
    // const apiKey = await createApiKey(email);
    // const workflow = await createTestWorkflow(email, {
    //   name: "E2E Webhook Test",
    //   triggerType: "webhook",
    //   enabled: true,
    // });
    // ========================================================================
    // STEP 3: SHARED UTILS - Trigger webhook via API
    // ========================================================================
    // Use Playwright's request context to trigger the webhook
    // (could also use fetch directly)
    // const webhookUrl = getWorkflowWebhookUrl(workflow.id, baseURL);
    // const response = await request.post(webhookUrl, {
    //   data: { test: true },
    //   headers: {
    //     "Content-Type": "application/json",
    //     Authorization: `Bearer ${apiKey}`,
    //   },
    // });
    // expect(response.ok()).toBe(true);
    // ========================================================================
    // STEP 4: SHARED UTILS - Wait for execution to complete
    // ========================================================================
    // Poll database until workflow execution finishes
    // const execution = await waitForWorkflowExecution(workflow.id, 60_000);
    // expect(execution?.status).toBe("success");
    // ========================================================================
    // STEP 5: PLAYWRIGHT - Verify results in UI (optional)
    // ========================================================================
    // If needed, verify the execution appears correctly in the UI
    // await page.goto(`/workflow/${workflow.id}`);
    // await waitForCanvas(page);
    //
    // // Switch to Runs tab
    // const runsTab = page.getByRole("tab", { name: "Runs" });
    // await runsTab.click();
    //
    // // Verify execution appears with success status
    // const successIndicator = page.locator(".bg-green-600").first();
    // await expect(successIndicator).toBeVisible({ timeout: 10_000 });
    // ========================================================================
    // CLEANUP: SHARED UTILS - Remove test data
    // ========================================================================
    // This would typically be in afterAll/afterEach
    // await deleteTestWorkflow(workflow.id);
    // await deleteApiKey(apiKey);
  });
});

// ============================================================================
// WHY THIS PATTERN?
// ============================================================================
//
// PROBLEM: Building workflows through UI is:
// - Slow (many clicks, waits)
// - Flaky (timing issues, animations)
// - Doesn't always create connected nodes properly
//
// SOLUTION: Split responsibilities:
//
// | Task                    | Tool       | Why                              |
// |-------------------------|------------|----------------------------------|
// | User signup             | Playwright | Tests the actual signup flow     |
// | Create workflow         | DB utils   | Fast, reliable, correct data     |
// | Create API key          | DB utils   | Fast, no UI needed               |
// | Trigger webhook         | HTTP       | Tests actual API endpoint        |
// | Wait for execution      | DB utils   | Fast polling, accurate status    |
// | Verify UI shows results | Playwright | Tests that UI reflects backend   |
//
// BENEFITS:
// 1. Tests are faster (skip slow UI interactions for data setup)
// 2. Tests are more reliable (DB injection is deterministic)
// 3. Tests still validate real user flows (signup, API calls, UI verification)
// 4. Shared utilities can be used by Vitest tests too
//
// ============================================================================
