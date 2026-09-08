import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Unmock db to use real database for integration tests
vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));

import {
  organization,
  organizationApiKeys,
  users,
  workflows as workflowsTable,
} from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";
import { PERSISTENT_TEST_USER_EMAIL } from "../../utils/db";

/**
 * Integration tests for API Key Authentication
 *
 * These tests require:
 * 1. A running database with proper schema
 * 2. A running app server at localhost:3000
 * 3. Persistent test user provisioned (pnpm db:seed-test-wallet)
 *
 * Tests are skipped if infrastructure is not available.
 */

const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

// Track setup state
let setupSucceeded = false;

describe.skipIf(shouldSkip)("API Key Authentication", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let testApiKey: string;
  let testApiKeyId: string;
  let testOrgId: string;
  let testUserId: string;
  let testWorkflowId: string;
  // Second org for cross-org isolation tests
  let otherOrgId: string;
  let otherUserId: string;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Track all created API key IDs for cleanup
  const createdApiKeyIds: string[] = [];
  const createdWorkflowIds: string[] = [];

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/keeperhub";
    client = postgres(connectionString, { max: 5 });
    db = drizzle(client);

    try {
      // Check if app is reachable
      const healthCheck = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);

      if (!healthCheck?.ok) {
        console.warn("API Key auth tests skipped: App not reachable");
        return;
      }

      // Look up persistent test user
      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.email, PERSISTENT_TEST_USER_EMAIL))
        .limit(1);

      if (!existingUser) {
        console.warn(
          "API Key auth tests skipped: Persistent test user not found. Run pnpm db:seed-test-wallet first."
        );
        return;
      }
      testUserId = existingUser.id;

      // Look up persistent test org
      const [testOrg] = await db
        .select()
        .from(organization)
        .where(eq(organization.slug, "e2e-test-org"))
        .limit(1);

      if (!testOrg) {
        console.warn(
          "API Key auth tests skipped: Persistent test org not found. Run pnpm db:seed-test-wallet first."
        );
        return;
      }
      testOrgId = testOrg.id;

      // Create a second org + user for cross-org isolation tests
      otherUserId = generateId();
      otherOrgId = generateId();

      await db.insert(users).values({
        id: otherUserId,
        name: "Other Test User",
        email: `e2e-other-${Date.now()}@techops.services`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.insert(organization).values({
        id: otherOrgId,
        name: "Other E2E Org",
        slug: `e2e-other-org-${Date.now()}`,
        createdAt: new Date(),
      });

      // Create test API key for the persistent org
      testApiKey = `kh_test_${Date.now()}_${Math.random().toString(36)}`;
      const keyHash = createHash("sha256").update(testApiKey).digest("hex");

      const apiKeys = await db
        .insert(organizationApiKeys)
        .values({
          organizationId: testOrgId,
          name: "Test API Key",
          keyHash,
          keyPrefix: testApiKey.slice(0, 8),
          createdBy: testUserId,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        })
        .returning();

      if (!apiKeys?.[0]) {
        console.warn("API Key auth tests skipped: Failed to create API key");
        return;
      }
      testApiKeyId = apiKeys[0].id;
      createdApiKeyIds.push(testApiKeyId);

      // Create test workflow owned by the persistent org
      const workflows = await db
        .insert(workflowsTable)
        .values({
          name: "Test Workflow",
          description: "Test workflow for API key auth",
          organizationId: testOrgId,
          userId: testUserId,
          isAnonymous: false,
          nodes: [
            {
              id: "trigger-1",
              type: "trigger",
              position: { x: 0, y: 0 },
              data: {
                label: "Manual Trigger",
                type: "trigger",
                config: { triggerType: "Manual" },
                status: "idle",
              },
            },
          ],
          edges: [],
        })
        .returning();

      if (!workflows?.[0]) {
        console.warn("API Key auth tests skipped: Failed to create workflow");
        return;
      }
      testWorkflowId = workflows[0].id;
      createdWorkflowIds.push(testWorkflowId);
      setupSucceeded = true;
    } catch (error) {
      console.warn("API Key auth tests skipped:", error);
    }
  }, 30_000);

  afterAll(async () => {
    try {
      // Clean up created workflows
      for (const id of createdWorkflowIds) {
        await db
          .delete(workflowsTable)
          .where(eq(workflowsTable.id, id))
          .catch(() => {
            /* noop */
          });
      }
      // Clean up created API keys
      for (const id of createdApiKeyIds) {
        await db
          .delete(organizationApiKeys)
          .where(eq(organizationApiKeys.id, id))
          .catch(() => {
            /* noop */
          });
      }
      // Clean up the other org and user
      if (otherOrgId) {
        await db
          .delete(organization)
          .where(eq(organization.id, otherOrgId))
          .catch(() => {
            /* noop */
          });
      }
      if (otherUserId) {
        await db
          .delete(users)
          .where(eq(users.id, otherUserId))
          .catch(() => {
            /* noop */
          });
      }
    } catch {
      // Ignore cleanup errors
    }
    await client.end();
  });

  describe("GET /api/workflows", () => {
    it("should authenticate with valid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(`${baseUrl}/api/workflows`, {
        headers: { Authorization: `Bearer ${testApiKey}` },
      });
      expect(response.status).toBe(200);
      const workflows = await response.json();
      expect(Array.isArray(workflows)).toBe(true);
      expect(
        workflows.some((w: { id: string }) => w.id === testWorkflowId)
      ).toBe(true);
    });

    it("should reject invalid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(`${baseUrl}/api/workflows`, {
        headers: { Authorization: "Bearer kh_invalid_key" },
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });

    it("should reject malformed API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(`${baseUrl}/api/workflows`, {
        headers: { Authorization: "Bearer invalid_prefix_key" },
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });
  });

  describe("POST /api/workflows/create", () => {
    it("should create workflow with valid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(`${baseUrl}/api/workflows/create`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "API Created Workflow",
          description: "Created via API key",
          nodes: [
            {
              id: "trigger-1",
              type: "trigger",
              position: { x: 0, y: 0 },
              data: {
                label: "Manual Trigger",
                type: "trigger",
                config: { triggerType: "Manual" },
                status: "idle",
              },
            },
          ],
          edges: [],
        }),
      });

      expect(response.status).toBe(200);
      const workflow = await response.json();
      expect(workflow.name).toBe("API Created Workflow");
      expect(workflow.organizationId).toBe(testOrgId);

      // Track for cleanup
      createdWorkflowIds.push(workflow.id);
    });

    it("should reject invalid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(`${baseUrl}/api/workflows/create`, {
        method: "POST",
        headers: {
          Authorization: "Bearer kh_invalid_key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Should Fail", nodes: [], edges: [] }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/workflows/:id", () => {
    it("should get workflow with valid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(
        `${baseUrl}/api/workflows/${testWorkflowId}`,
        {
          headers: { Authorization: `Bearer ${testApiKey}` },
        }
      );
      expect(response.status).toBe(200);
      const workflow = await response.json();
      expect(workflow.id).toBe(testWorkflowId);
    });

    it("should reject access to workflow from different org", async ({
      skip,
    }) => {
      if (!setupSucceeded) {
        skip();
      }
      const otherApiKey = `kh_other_${Date.now()}`;
      const otherKeyHash = createHash("sha256")
        .update(otherApiKey)
        .digest("hex");
      const otherKeys = await db
        .insert(organizationApiKeys)
        .values({
          organizationId: otherOrgId,
          name: "Other Org Key",
          keyHash: otherKeyHash,
          keyPrefix: otherApiKey.slice(0, 8),
        })
        .returning();

      if (otherKeys?.[0]) {
        createdApiKeyIds.push(otherKeys[0].id);
      }

      const response = await fetch(
        `${baseUrl}/api/workflows/${testWorkflowId}`,
        {
          headers: { Authorization: `Bearer ${otherApiKey}` },
        }
      );
      expect(response.status).toBe(404);
    });
  });

  describe("PATCH /api/workflows/:id", () => {
    it("should update workflow with valid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(
        `${baseUrl}/api/workflows/${testWorkflowId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${testApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Updated via API Key" }),
        }
      );
      expect(response.status).toBe(200);
      const workflow = await response.json();
      expect(workflow.name).toBe("Updated via API Key");
    });
  });

  describe("POST /api/workflow/:id/execute", () => {
    it("should execute workflow with valid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(
        `${baseUrl}/api/workflow/${testWorkflowId}/execute`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ input: { test: "data" } }),
        }
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.executionId).toBeDefined();
      expect(result.status).toBe("running");
    });

    it("should mask execution from different org", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const otherApiKey = `kh_other_exec_${Date.now()}`;
      const otherKeyHash = createHash("sha256")
        .update(otherApiKey)
        .digest("hex");
      const otherKeys = await db
        .insert(organizationApiKeys)
        .values({
          organizationId: otherOrgId,
          name: "Other Org Execute Key",
          keyHash: otherKeyHash,
          keyPrefix: otherApiKey.slice(0, 8),
        })
        .returning();

      if (otherKeys?.[0]) {
        createdApiKeyIds.push(otherKeys[0].id);
      }

      const response = await fetch(
        `${baseUrl}/api/workflow/${testWorkflowId}/execute`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${otherApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ input: { test: "data" } }),
        }
      );
      expect(response.status).toBe(404);
    });
  });

  // Skipped: the /api/ai/generate prompt-to-workflow endpoint is no longer
  // used by the frontend app. The deploy image ships NEXT_PUBLIC_AI_PROMPT_ENABLED
  // false, so the route returns 503 (service unavailable) before auth, which
  // these assertions (200 / 401) cannot satisfy.
  describe.skip("POST /api/ai/generate", () => {
    it("should generate workflow with valid API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(`${baseUrl}/api/ai/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "Create a simple workflow that sends an email",
        }),
      });
      // 500 means AI key is not configured — skip rather than fail
      if (response.status === 500) {
        console.warn(
          "AI generate test skipped: AI gateway returned 500 (API key not configured)"
        );
        return;
      }
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/x-ndjson"
      );
    });

    it("should reject without authentication", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const response = await fetch(`${baseUrl}/api/ai/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Create a workflow" }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("Expired API Keys", () => {
    it("should reject expired API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const expiredKey = `kh_expired_${Date.now()}`;
      const expiredKeyHash = createHash("sha256")
        .update(expiredKey)
        .digest("hex");
      const keys = await db
        .insert(organizationApiKeys)
        .values({
          organizationId: testOrgId,
          name: "Expired Key",
          keyHash: expiredKeyHash,
          keyPrefix: expiredKey.slice(0, 8),
          expiresAt: new Date(Date.now() - 1000),
        })
        .returning();

      if (keys?.[0]) {
        createdApiKeyIds.push(keys[0].id);
      }

      const response = await fetch(`${baseUrl}/api/workflows`, {
        headers: { Authorization: `Bearer ${expiredKey}` },
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });
  });

  describe("Revoked API Keys", () => {
    it("should reject revoked API key", async ({ skip }) => {
      if (!setupSucceeded) {
        skip();
      }
      const revokedKey = `kh_revoked_${Date.now()}`;
      const revokedKeyHash = createHash("sha256")
        .update(revokedKey)
        .digest("hex");
      const keys = await db
        .insert(organizationApiKeys)
        .values({
          organizationId: testOrgId,
          name: "Revoked Key",
          keyHash: revokedKeyHash,
          keyPrefix: revokedKey.slice(0, 8),
          revokedAt: new Date(),
        })
        .returning();

      if (keys?.[0]) {
        createdApiKeyIds.push(keys[0].id);
      }

      const response = await fetch(`${baseUrl}/api/workflows`, {
        headers: { Authorization: `Bearer ${revokedKey}` },
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });
  });
});
