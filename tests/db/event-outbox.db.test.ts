/**
 * The execution event outbox against a real Postgres.
 *
 * The unit suite proves which events writeDirectExecutionStatus asks for. Only
 * a real database shows that the unique dedupe key holds a second terminal
 * write to one event, and that a status write and its event commit or roll
 * back together.
 */

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  directExecutions,
  eventOutbox,
  organization,
} from "../../lib/db/schema";

vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const queryClient = postgres(DATABASE_URL, { max: 2 });
const testDb = drizzle(queryClient);

const PREFIX = "test_event_outbox_";
const ORG = `${PREFIX}org`;
const EXECUTION = `${PREFIX}exec`;

async function cleanup(): Promise<void> {
  await testDb.delete(eventOutbox).where(eq(eventOutbox.organizationId, ORG));
  await testDb
    .delete(directExecutions)
    .where(eq(directExecutions.organizationId, ORG));
}

async function outboxRows(): Promise<(typeof eventOutbox.$inferSelect)[]> {
  return await testDb
    .select()
    .from(eventOutbox)
    .where(eq(eventOutbox.executionId, EXECUTION));
}

async function executionStatus(): Promise<string | undefined> {
  const [row] = await testDb
    .select({ status: directExecutions.status })
    .from(directExecutions)
    .where(eq(directExecutions.id, EXECUTION));
  return row?.status;
}

async function settle(
  status: "completed" | "failed",
  guard?: "unconfirmed"
): Promise<number> {
  const { directExecutionEventColumns, writeDirectExecutionStatus } =
    await import("../../lib/outbound-webhooks/direct-execution-events");
  const rows = await writeDirectExecutionStatus((tx) =>
    tx
      .update(directExecutions)
      .set({
        status,
        error: status === "failed" ? "reverted" : null,
        transactionHash: "0xabc",
        completedAt: new Date(),
      })
      .where(
        guard
          ? and(
              eq(directExecutions.id, EXECUTION),
              eq(directExecutions.status, guard)
            )
          : eq(directExecutions.id, EXECUTION)
      )
      .returning(directExecutionEventColumns())
  );
  return rows.length;
}

beforeAll(async () => {
  await testDb
    .insert(organization)
    .values({ id: ORG, name: "t", slug: ORG, createdAt: new Date() })
    .onConflictDoNothing();
});

beforeEach(async () => {
  await cleanup();
  vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "true");
  await testDb.insert(directExecutions).values({
    id: EXECUTION,
    organizationId: ORG,
    apiKeyId: `${PREFIX}key`,
    type: "transfer",
    network: "base-sepolia",
    status: "running",
  });
});

afterAll(async () => {
  await cleanup();
  await testDb.delete(organization).where(eq(organization.id, ORG));
  vi.unstubAllEnvs();
  await queryClient.end();
});

describe("event_outbox (real database)", () => {
  it("writes one event when a direct execution completes", async () => {
    await settle("completed");

    const events = await outboxRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ORG,
      eventType: "direct_execution.succeeded",
      dedupeKey: `direct_execution:${EXECUTION}`,
      dispatchedAt: null,
      data: expect.objectContaining({
        executionId: EXECUTION,
        status: "completed",
        transactionHash: "0xabc",
      }),
    });
  });

  it("keeps the first event when the terminal write runs again", async () => {
    await settle("failed");
    await settle("completed");

    const events = await outboxRows();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("direct_execution.failed");
  });

  it("writes nothing when a guarded settle finds the row already settled", async () => {
    // The reconciler only settles rows still unconfirmed; this one is running.
    const settled = await settle("completed", "unconfirmed");

    expect(settled).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("rolls the status write back when its transaction fails", async () => {
    // The write is not committed on its own: anything that fails the
    // transaction, the event insert included, undoes the status too.
    const { directExecutionEventColumns, writeDirectExecutionStatus } =
      await import("../../lib/outbound-webhooks/direct-execution-events");

    await expect(
      writeDirectExecutionStatus(async (tx) => {
        await tx
          .update(directExecutions)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(directExecutions.id, EXECUTION))
          .returning(directExecutionEventColumns());
        throw new Error("abort after the update");
      })
    ).rejects.toThrow("abort after the update");

    expect(await executionStatus()).toBe("running");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("writes nothing while the flag is off", async () => {
    vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "");

    await settle("completed");

    expect(await executionStatus()).toBe("completed");
    expect(await outboxRows()).toHaveLength(0);
  });
});
