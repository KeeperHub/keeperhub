/**
 * writeDirectExecutionStatus is the one path a direct execution takes into a
 * final state, and the place its outbox event is written. These tests drive
 * it against a recording stand-in for db.transaction, so they can assert that
 * the event goes through the same transaction as the status write and is
 * written exactly for the statuses that are final.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventOutbox } from "@/lib/db/schema";
import type { DirectExecutionEventRow } from "@/lib/outbound-webhooks/direct-execution-events";

vi.mock("server-only", () => ({}));

type Insert = {
  tx: unknown;
  table: unknown;
  values: Record<string, unknown>;
  conflict: { target: unknown };
};

const state = vi.hoisted(() => ({
  inserts: [] as Insert[],
  transactions: 0,
  insertError: null as Error | null,
}));

vi.mock("@/lib/db", () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => {
      state.transactions += 1;
      const tx = {
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => ({
            onConflictDoNothing: (conflict: { target: unknown }) => {
              if (state.insertError) {
                return Promise.reject(state.insertError);
              }
              state.inserts.push({ tx, table, values, conflict });
              return Promise.resolve(undefined);
            },
          }),
        }),
      };
      return cb(tx);
    },
  },
}));

import {
  directExecutionEventType,
  writeDirectExecutionStatus,
} from "@/lib/outbound-webhooks/direct-execution-events";

const COMPLETED_AT = new Date("2026-10-10T12:00:00.000Z");

function row(
  overrides: Partial<DirectExecutionEventRow> = {}
): DirectExecutionEventRow {
  return {
    id: "exec_1",
    organizationId: "org_1",
    type: "transfer",
    status: "completed",
    network: "base-sepolia",
    transactionHash: "0xabc",
    error: null,
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

beforeEach(() => {
  state.inserts = [];
  state.transactions = 0;
  state.insertError = null;
  vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("directExecutionEventType", () => {
  it.each([
    ["completed", "direct_execution.succeeded"],
    ["failed", "direct_execution.failed"],
    ["unconfirmed", null],
    ["pending", null],
    ["running", null],
  ])("maps %s to %s", (status, expected) => {
    expect(directExecutionEventType(status)).toBe(expected);
  });
});

describe("writeDirectExecutionStatus", () => {
  it("writes the event through the transaction the status write ran on", async () => {
    let writeTx: unknown;

    const rows = await writeDirectExecutionStatus((tx) => {
      writeTx = tx;
      return Promise.resolve([row()]);
    });

    expect(rows).toEqual([row()]);
    expect(state.transactions).toBe(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]?.tx).toBe(writeTx);
    expect(state.inserts[0]?.table).toBe(eventOutbox);
  });

  it("records a completed execution as succeeded, deduplicated on the execution", async () => {
    await writeDirectExecutionStatus(() => Promise.resolve([row()]));

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

  it("records a failed execution as failed, with its error", async () => {
    await writeDirectExecutionStatus(() =>
      Promise.resolve([
        row({ status: "failed", transactionHash: null, error: "reverted" }),
      ])
    );

    expect(state.inserts[0]?.values).toMatchObject({
      eventType: "direct_execution.failed",
      dedupeKey: "direct_execution:exec_1",
      data: { status: "failed", transactionHash: null, error: "reverted" },
    });
  });

  it.each(["unconfirmed", "pending", "running"])(
    "records nothing for %s, which is not final",
    async (status) => {
      const rows = await writeDirectExecutionStatus(() =>
        Promise.resolve([row({ status, completedAt: null })])
      );

      expect(rows).toHaveLength(1);
      expect(state.inserts).toHaveLength(0);
    }
  );

  it("records nothing when the write matched no row", async () => {
    // A guarded update that lost a race to another writer returns no rows.
    const rows = await writeDirectExecutionStatus(() => Promise.resolve([]));

    expect(rows).toEqual([]);
    expect(state.inserts).toHaveLength(0);
  });

  it("records one event per final row the write returned", async () => {
    await writeDirectExecutionStatus(() =>
      Promise.resolve([
        row({ id: "exec_a" }),
        row({ id: "exec_b", status: "unconfirmed", completedAt: null }),
        row({ id: "exec_c", status: "failed" }),
      ])
    );

    expect(state.inserts.map((insert) => insert.values.dedupeKey)).toEqual([
      "direct_execution:exec_a",
      "direct_execution:exec_c",
    ]);
  });

  it("leaves the event data to the fields the status API already returns", async () => {
    await writeDirectExecutionStatus(() => Promise.resolve([row()]));

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

  it("fails the whole write when the event cannot be recorded", async () => {
    // The status write and its event commit together or not at all, so an
    // outbox failure must surface rather than leave a status with no event.
    state.insertError = new Error("outbox unavailable");

    await expect(
      writeDirectExecutionStatus(() => Promise.resolve([row()]))
    ).rejects.toThrow("outbox unavailable");
  });

  it("still applies the status write but records nothing while the flag is off", async () => {
    vi.stubEnv("OUTBOUND_WEBHOOKS_ENABLED", "");
    const write = vi.fn(() => Promise.resolve([row()]));

    const rows = await writeDirectExecutionStatus(write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([row()]);
    expect(state.inserts).toHaveLength(0);
  });
});
