/**
 * Re-export shared database utilities for Playwright tests
 *
 * This file re-exports utilities from the shared tests/utils/db.ts
 * to maintain backward compatibility with existing Playwright test imports.
 */

export type {
  CreateTestWorkflowOptions,
  ExecutionResult,
  TestWorkflow,
  WorkflowTriggerType,
} from "../../../utils/db";
export {
  addTestOrganization,
  createApiKey,
  createTestWorkflow,
  deleteApiKey,
  deleteTestWorkflow,
  getUserIdByEmail,
  getUserOrganizationId,
  getWorkflowWebhookUrl,
  PERSISTENT_TEST_USER_EMAIL,
  removeTestOrganization,
  waitForWorkflowExecution,
} from "../../../utils/db";

export const PERSISTENT_TEST_PASSWORD = "TestPassword123!";

export const PERSISTENT_INVITER_EMAIL = "pr-test-inviter@techops.services";
export const PERSISTENT_MEMBER_EMAIL = "pr-test-member@techops.services";
export const PERSISTENT_BYSTANDER_EMAIL = "pr-test-bystander@techops.services";
// Owner of a 'pro'-plan org; for tests that exercise feature-gated actions.
export const PERSISTENT_PRO_EMAIL = "pr-test-pro@techops.services";
// Seeded with a week of workflow and direct runs (seedAnalyticsData).
export const ANALYTICS_TEST_EMAIL = "test-analytics@techops.services";
export const ANALYTICS_TEST_PASSWORD = "TestAnalytics123!";
