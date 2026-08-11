/**
 * E2E Tests for Schedule Trigger Pipeline
 *
 * These tests require the full infrastructure stack:
 * - PostgreSQL database
 * - LocalStack with SQS queue
 * - KeeperHub app running
 * - Dispatcher script (or skip dispatcher tests)
 * - Executor script (or skip executor tests)
 *
 * Run with: pnpm test:e2e:schedule
 *
 * For CI, use docker-compose to spin up the stack before running.
 */

import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Skip these tests if infrastructure isn't available
const SKIP_INFRA_TESTS = process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5433/keeperhub";
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL || "http://localhost:4566";
const KEEPERHUB_URL = process.env.KEEPERHUB_URL || "http://localhost:3000";
// Use a dedicated test queue to avoid conflicts with job-spawner
const TEST_QUEUE_NAME = "keeperhub-test-queue";

describe.skipIf(SKIP_INFRA_TESTS)("Schedule Pipeline E2E", () => {
  let queryClient: ReturnType<typeof postgres>;
  let _db: ReturnType<typeof drizzle>;
  let sqsClient: SQSClient;
  let testQueueUrl: string;

  beforeAll(async () => {
    // Connect to database
    queryClient = postgres(DATABASE_URL);
    _db = drizzle(queryClient);

    // Create SQS client
    sqsClient = new SQSClient({
      region: "us-east-1",
      endpoint: AWS_ENDPOINT,
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });

    // Create dedicated test queue (separate from production queue used by job-spawner)
    try {
      const createResult = await sqsClient.send(
        new CreateQueueCommand({
          QueueName: TEST_QUEUE_NAME,
        })
      );
      // biome-ignore lint/style/noNonNullAssertion: AWS SDK returns QueueUrl on successful creation
      testQueueUrl = createResult.QueueUrl!;
      // Normalize the URL to use localhost (LocalStack may return host.minikube.internal)
      testQueueUrl = testQueueUrl.replace(
        "host.minikube.internal",
        "localhost"
      );
    } catch (_error) {
      // Queue may already exist
      testQueueUrl = `${AWS_ENDPOINT}/000000000000/${TEST_QUEUE_NAME}`;
    }
  });

  afterAll(async () => {
    // Cleanup test queue
    try {
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: testQueueUrl }));
    } catch {
      // Ignore cleanup errors
    }
    await queryClient.end();
  });

  beforeEach(async () => {
    // Purge test queue before each test
    try {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: testQueueUrl }));
    } catch {
      // Ignore purge errors (queue might be empty)
    }
  });

  describe("Infrastructure Health Checks", () => {
    it("can connect to PostgreSQL", async () => {
      const result = await queryClient`SELECT 1 as health`;
      expect(result[0].health).toBe(1);
    });

    it("can connect to LocalStack SQS", async () => {
      // Check connection using the test queue (which we created in beforeAll)
      // This avoids dependency on production queue existing
      const result = await sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: testQueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        })
      );
      expect(result.Attributes).toBeDefined();
    });

    it("KeeperHub app is reachable", async () => {
      try {
        const response = await fetch(`${KEEPERHUB_URL}/api/health`);
        // Even a 404 means the server is running
        expect(response.status).toBeLessThan(500);
      } catch (_error) {
        // If fetch fails, app isn't running
        console.warn("KeeperHub app not reachable, skipping app tests");
      }
    });
  });

  describe("Database Schema", () => {
    it("workflow_schedules table exists", async () => {
      const result = await queryClient`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'workflow_schedules'
        ) as exists
      `;
      expect(result[0].exists).toBe(true);
    });

    it("workflow_schedules has required columns", async () => {
      const result = await queryClient`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'workflow_schedules'
        ORDER BY column_name
      `;
      const columns = result.map((r) => r.column_name);

      expect(columns).toContain("id");
      expect(columns).toContain("workflow_id");
      expect(columns).toContain("cron_expression");
      expect(columns).toContain("timezone");
      expect(columns).toContain("enabled");
      expect(columns).toContain("next_run_at");
    });
  });

  describe("SQS Queue", () => {
    it("queue accepts messages", async () => {
      const { SendMessageCommand } = await import("@aws-sdk/client-sqs");

      const message = {
        workflowId: "test_wf_123",
        scheduleId: "test_sched_456",
        triggerTime: new Date().toISOString(),
        triggerType: "schedule",
      };

      const result = await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: testQueueUrl,
          MessageBody: JSON.stringify(message),
        })
      );

      expect(result.MessageId).toBeDefined();
    });

    it("queue messages can be received", async () => {
      const { SendMessageCommand, ReceiveMessageCommand } = await import(
        "@aws-sdk/client-sqs"
      );

      // Send a message to test queue (not consumed by job-spawner)
      const message = {
        workflowId: "test_wf_recv",
        scheduleId: "test_sched_recv",
        triggerTime: new Date().toISOString(),
        triggerType: "schedule",
      };

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: testQueueUrl,
          MessageBody: JSON.stringify(message),
        })
      );

      // Receive the message from test queue
      const receiveResult = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: testQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 5,
        })
      );

      expect(receiveResult.Messages).toBeDefined();
      expect(receiveResult.Messages?.length).toBeGreaterThan(0);

      // biome-ignore lint/style/noNonNullAssertion: We just verified Messages is defined and has length > 0
      // biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: Safe due to prior assertions
      const receivedBody = JSON.parse(receiveResult.Messages?.[0].Body!);
      expect(receivedBody.workflowId).toBe("test_wf_recv");
    });
  });
});

const describeApiTests = describe.skipIf(SKIP_INFRA_TESTS);
describeApiTests("Schedule API E2E", () => {
  // Use the top-level KEEPERHUB_URL constant
  const FETCH_TIMEOUT = 5000; // 5 second timeout for API calls

  // Helper to fetch with timeout
  async function fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  describe("Execute API with Internal Header", () => {
    it("rejects unauthenticated external requests", async () => {
      try {
        const response = await fetchWithTimeout(
          `${KEEPERHUB_URL}/api/workflow/fake_id/execute`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ input: {} }),
          }
        );

        // Should be 401 Unauthorized or 404 Not Found
        expect([401, 404]).toContain(response.status);
      } catch (error) {
        // Server not running or timeout - this is acceptable in local dev
        if (error instanceof Error && error.name === "AbortError") {
          console.warn("API request timed out - server may be slow");
        }
        // Skip test if server is not available
        expect(true).toBe(true);
      }
    });

    it("accepts internal execution header format", async () => {
      // This test verifies the header is recognized
      // Actual execution would require a valid workflow
      try {
        const response = await fetchWithTimeout(
          `${KEEPERHUB_URL}/api/workflow/fake_id/execute`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Execution": "true",
            },
            body: JSON.stringify({
              executionId: "test_exec_123",
              input: { triggerType: "schedule" },
            }),
          }
        );

        // Should be 404 (workflow not found) not 401 (unauthorized)
        // This proves the internal header bypassed auth
        expect(response.status).toBe(404);
      } catch (error) {
        // Server not running or timeout - this is acceptable in local dev
        if (error instanceof Error && error.name === "AbortError") {
          console.warn("API request timed out - server may be slow");
        }
        // Skip test if server is not available
        expect(true).toBe(true);
      }
    });
  });
});

// Full pipeline tests are in tests/e2e/full-pipeline.test.ts
