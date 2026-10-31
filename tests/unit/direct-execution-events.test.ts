/**
 * setDirectExecutionStatus is the single writer of direct_executions.status
 * and the place a final status records its outbox event. These tests drive it
 * against a recording stand-in for the database, so they can assert which
 * writes open a transaction, that the event goes into a savepoint on the same
 * transaction as the UPDATE, and what the UPDATE's guard allows.
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventOutbox } from "@/lib/db/schema";
import {
  DIRECT_EXECUTION_STATUSES,
  DIRECT_EXECUTION_TERMINAL_STATUSES,
  DirectExecutionStatus,
} from "@/lib/errors/execution-status";
import { ErrorCategory } from "@/lib/logging";
import type { DirectExecutionEventRow } from "@/lib/outbound-webhooks/direct-execution-events";
import {
  DIRECT_EXECUTION_EVENT_TYPE_BY_STATUS,
  DIRECT_EXECUTION_EVENT_TYPES,
} from "@/lib/outbound-webhooks/event-types";

vi.mock("server-only", () => ({}));

type Update = {
  executor: "db" | "tx";
  patch: Record<string, unknown>;
  where: unknown;
};

type Insert = {
  table: unknown;
  values: Record<string, unknown>;
  conflict: { target: unknown };
};

const state = vi.hoisted(() => ({
  updates: [] as Update[],
  inserts: [] as Insert[],
  transactions: 0,
  savepoints: 0,
  returned: [] as unknown[],
  insertError: null as Error | null,
}));

const logSystemError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemError,
}));

vi.mock("@/lib/db", () => {
  const updater = (executor: Update["executor"]) => ({
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          returning: () => {
            state.updates.push({ executor, patch, where });
            return Promise.resolve(state.returned);
          },
        }),
      }),
    }),
  });
  const savepoint = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: (conflict: { target: unknown }) => {
          if (state.insertError) {
            return Promise.reject(state.insertError);
          }
          state.inserts.push({ table, values, conflict });
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
  const tx = {
    ...updater("tx"),
    transaction: (cb: (sp: unknown) => unknown) => {
      state.savepoints += 1;
      return cb(savepoint);
    },
  };
  return {
    db: {
      ...updater("db"),
      transaction: (cb: (t: unknown) => unknown) => {
        state.transactions += 1;
        return cb(tx);
      },
    },
  };
});

import {
  sanitizeEventError,
  setDirectExecutionStatus,
} from "@/lib/outbound-webhooks/direct-execution-events";

const COMPLETED_AT = new Date("2026-10-10T12:00:00.000Z");
const dialect = new PgDialect();

function row(
  overrides: Partial<DirectExecutionEventRow> = {}
): DirectExecutionEventRow {
  return {
    id: "exec_1",
    organizationId: "org_1",
    type: "transfer",
    status: DirectExecutionStatus.COMPLETED,
    network: "base-sepolia",
    transactionHash: "0xabc",
    error: null,
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

function renderedWhere(): { sql: string; params: unknown[] } {
  const where = state.updates[0]?.where as SQL;
  return dialect.sqlToQuery(where);
}

beforeEach(() => {
  state.updates = [];
  state.inserts = [];
  state.transactions = 0;
  state.savepoints = 0;
  state.returned = [row()];
  state.insertError = null;
  logSystemError.mockClear();
  vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("direct-execution event constants", () => {
  it("gives every final status an event", () => {
    expect(DIRECT_EXECUTION_EVENT_TYPE_BY_STATUS).toEqual({
      completed: DIRECT_EXECUTION_EVENT_TYPES.succeeded,
      failed: DIRECT_EXECUTION_EVENT_TYPES.failed,
    });
    expect(Object.keys(DIRECT_EXECUTION_EVENT_TYPE_BY_STATUS).sort()).toEqual(
      [...DIRECT_EXECUTION_TERMINAL_STATUSES].sort()
    );
  });

  it("only treats real statuses as final", () => {
    for (const status of DIRECT_EXECUTION_TERMINAL_STATUSES) {
      expect(DIRECT_EXECUTION_STATUSES).toContain(status);
    }
  });
});

describe("sanitizeEventError", () => {
  it("keeps a null error null", () => {
    expect(sanitizeEventError(null)).toBeNull();
  });

  it("replaces control characters with a space", () => {
    expect(sanitizeEventError("reverted\n\treason:\u0000bad\u009b\r\n")).toBe(
      "reverted reason: bad"
    );
  });

  it("leaves a short, clean message unchanged", () => {
    expect(sanitizeEventError("insufficient funds for gas")).toBe(
      "insufficient funds for gas"
    );
  });

  it("cuts a long message to 1 KiB", () => {
    const sanitized = sanitizeEventError("x".repeat(5000)) ?? "";

    expect(Buffer.byteLength(sanitized)).toBe(1024);
  });

  it("does not split a multi-byte character at the 1 KiB boundary", () => {
    // Three bytes each, so 1024 bytes falls part-way through one.
    const sanitized = sanitizeEventError("€".repeat(400)) ?? "";

    expect(Buffer.byteLength(sanitized)).toBe(1023);
    expect(sanitized).toBe("€".repeat(341));
  });
});

describe("setDirectExecutionStatus", () => {
  it("writes a final status and its event in one transaction, the event in a savepoint", async () => {
    const result = await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.COMPLETED,
    });

    expect(result).toEqual(row());
    expect(state.transactions).toBe(1);
    expect(state.updates.map((update) => update.executor)).toEqual(["tx"]);
    expect(state.savepoints).toBe(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]?.table).toBe(eventOutbox);
  });

  it("records a completed execution as succeeded, deduplicated on the execution", async () => {
    await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.COMPLETED,
    });

    expect(state.inserts[0]?.values).toEqual({
      organizationId: "org_1",
      eventType: "direct_execution.succeeded",
      executionId: "exec_1",
      dedupeKey: "direct_execution:exec_1",
      data: {
        executionId: "exec_1",
        type: "transfer",
        status: "completed",
        network: "base-sepolia",
        transactionHash: "0xabc",
        error: null,
        completedAt: "2026-10-10T12:00:00.000Z",
      },
    });
    expect(state.inserts[0]?.conflict).toEqual({
      target: eventOutbox.dedupeKey,
    });
  });

  it("records a failed execution as failed, with its error sanitized", async () => {
    state.returned = [
      row({
        status: DirectExecutionStatus.FAILED,
        transactionHash: null,
        error: `reverted\n${"x".repeat(3000)}`,
      }),
    ];

    await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.FAILED,
    });

    const values = state.inserts[0]?.values;
    expect(values).toMatchObject({
      eventType: "direct_execution.failed",
      dedupeKey: "direct_execution:exec_1",
      data: { status: "failed", transactionHash: null },
    });
    const error = String((values?.data as { error?: string })?.error);
    expect(error.startsWith("reverted x")).toBe(true);
    expect(Buffer.byteLength(error)).toBe(1024);
  });

  it("leaves the event data to the fields the status API already returns", async () => {
    await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.COMPLETED,
    });

    expect(Object.keys(state.inserts[0]?.values.data ?? {}).sort()).toEqual([
      "completedAt",
      "error",
      "executionId",
      "network",
      "status",
      "transactionHash",
      "type",
    ]);
  });

  it.each([
    DirectExecutionStatus.PENDING,
    DirectExecutionStatus.RUNNING,
    DirectExecutionStatus.UNCONFIRMED,
  ])(
    "writes %s as a single UPDATE with no transaction or event",
    async (status) => {
      state.returned = [row({ status, completedAt: null })];

      await setDirectExecutionStatus("exec_1", { status });

      expect(state.updates.map((update) => update.executor)).toEqual(["db"]);
      expect(state.transactions).toBe(0);
      expect(state.inserts).toHaveLength(0);
    }
  );

  it("writes a final status as a single UPDATE while the flag is off", async () => {
    vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "");

    const result = await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.COMPLETED,
      completedAt: COMPLETED_AT,
    });

    expect(result).toEqual(row());
    expect(state.updates).toEqual([
      expect.objectContaining({
        executor: "db",
        patch: {
          status: DirectExecutionStatus.COMPLETED,
          completedAt: COMPLETED_AT,
        },
      }),
    ]);
    expect(state.transactions).toBe(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("never overwrites a final status unless told which statuses to move from", async () => {
    await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.FAILED,
    });

    const { sql, params } = renderedWhere();
    expect(sql).toContain('"direct_executions"."status" not in');
    expect(params).toEqual(["exec_1", ...DIRECT_EXECUTION_TERMINAL_STATUSES]);
  });

  it("applies only from the statuses a caller names", async () => {
    await setDirectExecutionStatus(
      "exec_1",
      { status: DirectExecutionStatus.COMPLETED },
      { from: [DirectExecutionStatus.UNCONFIRMED] }
    );

    const { sql, params } = renderedWhere();
    expect(sql).toContain('"direct_executions"."status" in');
    expect(sql).not.toContain("not in");
    expect(params).toEqual(["exec_1", DirectExecutionStatus.UNCONFIRMED]);
  });

  it("returns null and records nothing when the guard matched no row", async () => {
    state.returned = [];

    const result = await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.COMPLETED,
    });

    expect(result).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it("keeps the status write when the event cannot be recorded, and logs it", async () => {
    state.insertError = new Error('relation "event_outbox" does not exist');

    const result = await setDirectExecutionStatus("exec_1", {
      status: DirectExecutionStatus.COMPLETED,
    });

    expect(result).toEqual(row());
    expect(logSystemError).toHaveBeenCalledWith(
      ErrorCategory.DATABASE,
      expect.stringContaining("[OutboundWebhook]"),
      state.insertError,
      {
        execution_id: "exec_1",
        event_type: DIRECT_EXECUTION_EVENT_TYPES.succeeded,
      }
    );
  });
});
