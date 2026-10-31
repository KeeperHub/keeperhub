/**
 * The execution event outbox against a real Postgres.
 *
 * The unit suite proves which writes setDirectExecutionStatus makes. Only a
 * real database shows that the status guard refuses a second final write,
 * that the unique dedupe key holds, and that a failed outbox insert inside its
 * savepoint leaves the status write committed.
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
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
import {
  DirectExecutionStatus,
  type DirectExecutionTerminalStatus,
} from "../../lib/errors/execution-status";

vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const logSystemError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemError,
}));

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

async function finish(
  status: DirectExecutionTerminalStatus,
  from?: DirectExecutionStatus[]
): Promise<boolean> {
  const { setDirectExecutionStatus } = await import(
    "../../lib/outbound-webhooks/direct-execution-events"
  );
  const updated = await setDirectExecutionStatus(
    EXECUTION,
    {
      status,
      error: status === DirectExecutionStatus.FAILED ? "reverted" : null,
      transactionHash: "0xabc",
      completedAt: new Date(),
    },
    from ? { from } : {}
  );
  return updated !== null;
}

beforeAll(async () => {
  await testDb
    .insert(organization)
    .values({ id: ORG, name: "t", slug: ORG, createdAt: new Date() })
    .onConflictDoNothing();
});

beforeEach(async () => {
  await cleanup();
  logSystemError.mockClear();
  vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "true");
  await testDb.insert(directExecutions).values({
    id: EXECUTION,
    organizationId: ORG,
    apiKeyId: `${PREFIX}key`,
    type: "transfer",
    network: "base-sepolia",
    status: DirectExecutionStatus.RUNNING,
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
    expect(await finish(DirectExecutionStatus.COMPLETED)).toBe(true);

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

  it("refuses a second final write, so the event always matches the row", async () => {
    expect(await finish(DirectExecutionStatus.FAILED)).toBe(true);
    expect(await finish(DirectExecutionStatus.COMPLETED)).toBe(false);

    expect(await executionStatus()).toBe(DirectExecutionStatus.FAILED);
    const events = await outboxRows();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("direct_execution.failed");
    expect(events[0]?.data).toMatchObject({ status: "failed" });
  });

  it("writes nothing when the row is not in a status the caller moves from", async () => {
    // The reconciler only settles rows still unconfirmed; this one is running.
    expect(
      await finish(DirectExecutionStatus.COMPLETED, [
        DirectExecutionStatus.UNCONFIRMED,
      ])
    ).toBe(false);

    expect(await executionStatus()).toBe(DirectExecutionStatus.RUNNING);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("keeps the status write when the outbox insert fails", async () => {
    // An environment whose migration lagged: the table is not there.
    await queryClient`ALTER TABLE event_outbox RENAME TO event_outbox_hidden`;
    try {
      expect(await finish(DirectExecutionStatus.COMPLETED)).toBe(true);
    } finally {
      await queryClient`ALTER TABLE event_outbox_hidden RENAME TO event_outbox`;
    }

    expect(await executionStatus()).toBe(DirectExecutionStatus.COMPLETED);
    expect(await outboxRows()).toHaveLength(0);
    expect(logSystemError).toHaveBeenCalledTimes(1);
  });

  it("writes a non-final status without an event", async () => {
    const { setDirectExecutionStatus } = await import(
      "../../lib/outbound-webhooks/direct-execution-events"
    );

    await setDirectExecutionStatus(EXECUTION, {
      status: DirectExecutionStatus.UNCONFIRMED,
    });

    expect(await executionStatus()).toBe(DirectExecutionStatus.UNCONFIRMED);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("writes nothing while the flag is off", async () => {
    vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "");

    await finish(DirectExecutionStatus.COMPLETED);

    expect(await executionStatus()).toBe(DirectExecutionStatus.COMPLETED);
    expect(await outboxRows()).toHaveLength(0);
  });
});
