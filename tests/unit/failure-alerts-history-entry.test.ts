import { describe, expect, it } from "vitest";
import {
  encodeHistoryCursor,
  type HistoryRow,
  parseHistoryCursor,
  toHistoryEntry,
} from "@/lib/notifications/failure-alerts/history-entry";

const CREATED = new Date("2026-10-01T10:00:00.000Z");
const LATER = new Date("2026-10-01T10:00:04.000Z");

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: "delivery_1",
    kind: "alert",
    channel: "email",
    recipient: "ops@example.com",
    connectionName: null,
    state: "delivered",
    attempts: 1,
    isBackup: false,
    lastStatus: null,
    lastError: null,
    context: null,
    createdAt: CREATED,
    updatedAt: LATER,
    deliveredAt: LATER,
    nextAttemptAt: CREATED,
    workflowId: "wf_nightly",
    workflowName: "Nightly sync",
    ...overrides,
  };
}

const NO_GROUPS = new Map<string, { id: string; name: string }>();

describe("toHistoryEntry", () => {
  it("maps a delivery onto a history entry with its workflow", () => {
    expect(toHistoryEntry(row({ lastStatus: 202 }), NO_GROUPS)).toEqual({
      id: "delivery_1",
      createdAt: CREATED.toISOString(),
      deliveredAt: LATER.toISOString(),
      kind: "alert",
      channel: "email",
      recipient: "ops@example.com",
      connectionName: null,
      isBackup: false,
      state: "delivered",
      attempts: 1,
      lastStatus: 202,
      lastError: null,
      nextAttemptAt: CREATED.toISOString(),
      note: null,
      by: "KeeperHub",
      byAccount: null,
      workflows: [{ id: "wf_nightly", name: "Nightly sync" }],
      pauseUntil: null,
    });
  });

  it("names a grouped message's workflows, dropping ones whose incident is gone", () => {
    const groups = new Map([["inc_a", { id: "wf_a", name: "A" }]]);
    const grouped = row({
      workflowId: null,
      workflowName: null,
      deliveredAt: null,
      context: { incidentIds: ["inc_a", "inc_gone"] },
    });
    expect(toHistoryEntry(grouped, groups).workflows).toEqual([
      { id: "wf_a", name: "A" },
    ]);
    expect(toHistoryEntry(grouped, groups).deliveredAt).toBeNull();
  });
});

describe("history cursor", () => {
  it("round-trips the time to the microsecond and the id", () => {
    const cursor = { at: "2026-10-01T10:00:00.123456", id: "abc_DEF-123" };
    expect(parseHistoryCursor(encodeHistoryCursor(cursor))).toEqual(cursor);
  });

  it("refuses anything the log never minted", () => {
    const bad = (text: string): string =>
      Buffer.from(text, "utf8").toString("base64url");
    for (const raw of [
      null,
      "",
      "abc",
      "2026-09-01T12:34:56.789Z",
      bad("2026-10-01T10:00:00.123~id"),
      bad("2026-02-31T10:00:00.123456~id"),
      bad("0000-01-01T00:00:00.000000~id"),
      bad("2026-10-01T10:00:00.123456~id with space"),
      bad("2026-10-01T10:00:00.123456~notification~id"),
    ]) {
      expect(parseHistoryCursor(raw), String(raw)).toBeUndefined();
    }
  });
});

describe("pause notice notes", () => {
  it("names who paused, resumed or tested, and keeps the pause reason", async () => {
    const { historyBy, historyNote } = await import(
      "@/lib/notifications/failure-alerts/view-types"
    );
    expect(
      historyBy({ by: "Dana", reason: "Vault upgrade" }, "alerts_paused")
    ).toBe("Dana");
    expect(
      historyNote({ by: "Dana", reason: "Vault upgrade" }, "alerts_paused")
    ).toBe("Reason: Vault upgrade");
    expect(historyBy({ by: "Dana" }, "alerts_resumed")).toBe("Dana");
    expect(historyNote({ by: "Dana" }, "alerts_resumed")).toBeNull();
    expect(historyBy({ by: null }, "alerts_resumed")).toBe("KeeperHub");
    expect(historyNote({ by: null }, "alerts_resumed")).toBe(
      "The pause ran out"
    );
    expect(historyBy({ by: "An owner" }, "test")).toBe("An owner");
    expect(historyBy({ by: "Dana" }, "alert")).toBe("KeeperHub");
  });
});
