import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import {
  organization,
  pythTriggerCheckpoints,
  users,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";
import {
  observePythPrice,
  type PythObservationRequest,
} from "@/lib/pyth/observe-price";
import {
  parsePythPriceUpdate,
  parsePythTriggerConfig,
} from "@/lib/pyth/price-trigger";
import { hashPythConfig } from "@/lib/pyth/trigger-config";
import { claimPhantomForExecution } from "../../keeperhub-executor/lib/db-helpers";

// Run against an isolated local DB initialized with pnpm db:push. This suite
// deliberately bypasses tests/setup.ts's global DB mock; every assertion
// below exercises real Postgres locks, unique indexes and transactions.
vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));
vi.hoisted(() => {
  if (process.env.PYTH_TEST_DATABASE_URL) {
    const url = new URL(process.env.PYTH_TEST_DATABASE_URL);
    if (
      !(
        ["localhost", "127.0.0.1"].includes(url.hostname) &&
        url.pathname.endsWith("_pyth")
      )
    ) {
      throw new Error(
        "Pyth integration tests require a dedicated local *_pyth database"
      );
    }
    process.env.DATABASE_URL = process.env.PYTH_TEST_DATABASE_URL;
  }
});

describe.skipIf(!process.env.PYTH_TEST_DATABASE_URL)(
  "Pyth durable observation (real Postgres)",
  () => {
    const userId = `pyth-test-${randomUUID()}`;
    const organizationId = `pyth-test-${randomUUID()}`;
    const config = parsePythTriggerConfig({
      feedId: "a".repeat(64),
      direction: "above",
      threshold: "100",
      rearmThreshold: "95",
      maxAgeSeconds: 30,
    });
    const configHash = hashPythConfig(config);
    let workflowId: string;
    let sessionId: string;
    let baseTime: number;
    const request = new Request("http://localhost/api/internal/pyth-triggers", {
      method: "POST",
    });
    const nodes = (value = config) => [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          config: { ...value, triggerType: "Pyth Price" },
        },
      },
    ];

    function command(
      price: string,
      offset: number,
      session = sessionId
    ): PythObservationRequest {
      return {
        action: "observe",
        workflowId,
        configHash,
        sessionId: session,
        update: parsePythPriceUpdate({
          id: config.feedId,
          price: { price, conf: "1", expo: 0, publish_time: baseTime + offset },
        }),
      };
    }
    const observe = (price: string, offset: number, session = sessionId) =>
      observePythPrice(command(price, offset, session), request);
    const pending = () =>
      observePythPrice(
        { action: "pending", workflowId, configHash, sessionId },
        request
      );

    beforeAll(async () => {
      vi.stubEnv("NEXT_PUBLIC_BILLING_ENABLED", "false");
      await db.insert(users).values({
        id: userId,
        name: "Pyth test",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(organization).values({
        id: organizationId,
        name: "Pyth tests",
        slug: organizationId,
        createdAt: new Date(),
      });
    });

    beforeEach(async () => {
      workflowId = `pyth-test-${randomUUID()}`;
      sessionId = randomUUID();
      baseTime = Math.floor(Date.now() / 1000) - 10;
      await db.insert(workflows).values({
        id: workflowId,
        name: "Pyth test",
        userId,
        organizationId,
        enabled: true,
        nodes: nodes(),
        edges: [],
      });
    });

    afterEach(async () => {
      await db
        .update(organization)
        .set({ haltedAt: null, deactivatedAt: null })
        .where(eq(organization.id, organizationId));
      await db
        .delete(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, workflowId));
      await db.delete(workflows).where(eq(workflows.id, workflowId));
    });

    afterAll(async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(users).where(eq(users.id, userId));
      vi.unstubAllEnvs();
    });

    it("lets exactly one concurrent executor claim a persisted Pyth dispatch", async () => {
      await observe("90", 0);
      const result = await observe("101", 1);
      const dispatch = result.pending;
      expect(dispatch).toBeDefined();
      if (!dispatch) {
        throw new Error("Expected a persisted dispatch");
      }
      // Use the executor's schema shape on its own real pool, matching the
      // separate consumer process rather than casting the app's DB handle.
      const client = postgres(process.env.PYTH_TEST_DATABASE_URL as string);
      const executorDb = drizzle(client, {
        schema: { workflows, workflowExecutions, workflowSchedules },
      });
      try {
        const outcomes = await Promise.all(
          Array.from({ length: 8 }, () =>
            claimPhantomForExecution(
              executorDb,
              dispatch.executionId,
              { ...dispatch.triggerData, configHash },
              "test-workflow-hash"
            )
          )
        );
        expect(
          outcomes.filter((outcome) => outcome === "claimed")
        ).toHaveLength(1);
        expect(
          outcomes.filter((outcome) => outcome === "already_advanced")
        ).toHaveLength(7);
      } finally {
        await client.end();
      }
    });

    it.each(["haltedAt", "deactivatedAt"] as const)(
      "blocks an organization with %s set",
      async (field) => {
        await db
          .update(organization)
          .set({ [field]: new Date() })
          .where(eq(organization.id, organizationId));
        expect((await observe("90", 0)).outcome).toBe("inactive");
        expect(
          await db
            .select()
            .from(pythTriggerCheckpoints)
            .where(eq(pythTriggerCheckpoints.workflowId, workflowId))
        ).toHaveLength(0);
      }
    );

    it("commits the threshold checkpoint and one phantom together", async () => {
      expect((await observe("94", 0)).outcome).toBe("baseline");
      const result = await observe("100", 1);
      expect(result.pending).toBeDefined();
      const [checkpoint] = await db
        .select()
        .from(pythTriggerCheckpoints)
        .where(eq(pythTriggerCheckpoints.workflowId, workflowId));
      const [execution] = await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, workflowId));
      expect(checkpoint.armed).toBe(false);
      expect(checkpoint.pending?.executionId).toBe(execution.id);
      expect(execution).toMatchObject({
        status: "phantom",
        billable: false,
        triggerSource: "upstream",
        userId,
        organizationId,
      });
      expect(execution.input).toMatchObject({
        speculative: true,
        sourceUpdateId: `pyth:${config.feedId}:${baseTime + 1}`,
      });
    });

    it("survives lost replies and concurrent replay with one execution identity", async () => {
      await observe("94", 0);
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => observe("100", 1))
      );
      const ids = new Set(
        responses.map((result) => result.pending?.executionId)
      );
      expect(ids.size).toBe(1);
      expect(ids.has(undefined)).toBe(false);
      const executions = await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, workflowId));
      expect(executions).toHaveLength(1);
      expect((await pending()).pending?.executionId).toBe(executions[0].id);
    });

    it("acknowledges only the matching pending execution and does not replay it", async () => {
      await observe("94", 0);
      const first = await observe("100", 1);
      const executionId = first.pending?.executionId as string;
      await observePythPrice(
        {
          action: "ack",
          workflowId,
          configHash,
          sessionId,
          executionId: "wrong",
        },
        request
      );
      expect((await pending()).pending?.executionId).toBe(executionId);
      await observePythPrice(
        { action: "ack", workflowId, configHash, sessionId, executionId },
        request
      );
      expect((await observe("100", 1)).outcome).toBe("out_of_order");
      expect((await observe("101", 2)).pending).toBeUndefined();
      await observe("95", 3);
      const next = await observe("100", 4);
      expect(next.pending?.executionId).toBeDefined();
      expect(next.pending?.executionId).not.toBe(executionId);
    });

    it("keeps one subscription owner and rebaselines on failover", async () => {
      await observe("94", 0);
      const replacement = randomUUID();
      expect((await observe("100", 1, replacement)).outcome).toBe("leased");
      await db
        .update(pythTriggerCheckpoints)
        .set({ leaseUntil: new Date(0) })
        .where(eq(pythTriggerCheckpoints.workflowId, workflowId));
      expect((await observe("100", 1, replacement)).outcome).toBe("baseline");
      expect((await pending()).pending).toBeUndefined();
    });

    it("expires pending signals without executing or billing them", async () => {
      await observe("94", 0);
      const first = await observe("100", 1);
      const stored = first.pending;
      expect(stored).toBeDefined();
      if (!stored) {
        throw new Error("Expected pending dispatch");
      }
      await db
        .update(pythTriggerCheckpoints)
        .set({
          pending: {
            ...stored,
            triggerData: { ...stored.triggerData, expiresAt: Date.now() - 1 },
          },
        })
        .where(eq(pythTriggerCheckpoints.workflowId, workflowId));
      expect((await pending()).pending).toBeUndefined();
      const [execution] = await db
        .select()
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, stored.executionId));
      expect(execution).toMatchObject({ status: "skipped", billable: false });
      expect((await observe("101", 2)).outcome).toBe("baseline");
    });

    it("rolls back the checkpoint if creating the execution fails", async () => {
      await observe("94", 0);
      // A real database error after matching, before commit. The check is
      // scoped to this test workflow and always removed in finally.
      await db.execute(
        sql.raw(
          `ALTER TABLE workflow_executions ADD CONSTRAINT pyth_test_reject CHECK (workflow_id <> '${workflowId}')`
        )
      );
      try {
        await expect(observe("100", 1)).rejects.toThrow();
        const [checkpoint] = await db
          .select()
          .from(pythTriggerCheckpoints)
          .where(eq(pythTriggerCheckpoints.workflowId, workflowId));
        expect(checkpoint).toMatchObject({
          armed: true,
          lastPublishTime: baseTime,
          pending: null,
        });
      } finally {
        await db.execute(
          sql`ALTER TABLE workflow_executions DROP CONSTRAINT pyth_test_reject`
        );
      }
      expect((await observe("100", 1)).pending).toBeDefined();
    });

    it("rejects disabled and deleted workflows without inserting checkpoints", async () => {
      await db
        .update(workflows)
        .set({ enabled: false })
        .where(eq(workflows.id, workflowId));
      expect((await observe("100", 0)).outcome).toBe("inactive");
      await db
        .update(workflows)
        .set({ enabled: true, deletedAt: new Date() })
        .where(eq(workflows.id, workflowId));
      expect((await observe("100", 0)).outcome).toBe("inactive");
      expect(
        await db
          .select()
          .from(pythTriggerCheckpoints)
          .where(eq(pythTriggerCheckpoints.workflowId, workflowId))
      ).toHaveLength(0);
    });

    it("rejects a stale listener configuration and retires the old pending signal", async () => {
      await observe("94", 0);
      const first = await observe("100", 1);
      const changed = { ...config, threshold: "110" };
      await db
        .update(workflows)
        .set({ nodes: nodes(changed) })
        .where(eq(workflows.id, workflowId));
      expect((await observe("110", 2)).outcome).toBe("config_changed");
      const next = await observePythPrice(
        { ...command("110", 2), configHash: hashPythConfig(changed) },
        request
      );
      expect(next.outcome).toBe("baseline");
      const [execution] = await db
        .select()
        .from(workflowExecutions)
        .where(
          and(
            eq(workflowExecutions.workflowId, workflowId),
            eq(workflowExecutions.id, first.pending?.executionId as string)
          )
        );
      expect(execution.status).toBe("skipped");
    });
  }
);
