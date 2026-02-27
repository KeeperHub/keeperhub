import { beforeEach, describe, expect, it } from "vitest";
import {
  collapseRetries,
  type RetryLogFields,
} from "@/keeperhub/lib/retry-grouping";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let logCounter = 0;

const BASE_TIME = new Date("2025-01-01T00:00:00Z");

function makeLog(overrides: Partial<RetryLogFields> = {}): RetryLogFields {
  logCounter += 1;
  return {
    nodeId: `node-${logCounter}`,
    status: "success",
    startedAt: new Date(BASE_TIME.getTime() + logCounter * 1000),
    iterationIndex: null,
    forEachNodeId: null,
    ...overrides,
  };
}

beforeEach(() => {
  logCounter = 0;
});

// ---------------------------------------------------------------------------
// collapseRetries
// ---------------------------------------------------------------------------

describe("collapseRetries", () => {
  it("returns an empty array for empty input", () => {
    const result = collapseRetries([]);
    expect(result).toEqual([]);
  });

  it("passes through logs with no retries unchanged", () => {
    const logs = [
      makeLog({ nodeId: "trigger-1", status: "success" }),
      makeLog({ nodeId: "write-1", status: "success" }),
      makeLog({ nodeId: "notify-1", status: "success" }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(3);
    for (const entry of result) {
      expect(entry.retryCount).toBe(0);
      expect(entry.retryLogs).toBeUndefined();
    }
  });

  it("collapses two logs with the same nodeId into one with retryCount=1", () => {
    const logs = [
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:01Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "success",
        startedAt: new Date("2025-01-01T00:00:02Z"),
      }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(1);
    expect(result[0].nodeId).toBe("write-1");
    expect(result[0].status).toBe("success");
    expect(result[0].retryCount).toBe(1);
    expect(result[0].retryLogs).toHaveLength(1);
    expect(result[0].retryLogs?.[0].status).toBe("error");
  });

  it("collapses three logs (2 failures + 1 success) into retryCount=2", () => {
    const logs = [
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:01Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:02Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "success",
        startedAt: new Date("2025-01-01T00:00:03Z"),
      }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("success");
    expect(result[0].retryCount).toBe(2);
    expect(result[0].retryLogs).toHaveLength(2);
  });

  it("collapses all-failed retries using latest attempt as display entry", () => {
    const logs = [
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:01Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:02Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:03Z"),
      }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("error");
    expect(result[0].retryCount).toBe(2);
  });

  it("handles mixed nodes where only some have retries", () => {
    const logs = [
      makeLog({ nodeId: "trigger-1", status: "success" }),
      makeLog({ nodeId: "write-1", status: "error" }),
      makeLog({ nodeId: "write-1", status: "success" }),
      makeLog({ nodeId: "notify-1", status: "success" }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(3);
    expect(result[0].nodeId).toBe("trigger-1");
    expect(result[0].retryCount).toBe(0);
    expect(result[1].nodeId).toBe("write-1");
    expect(result[1].retryCount).toBe(1);
    expect(result[2].nodeId).toBe("notify-1");
    expect(result[2].retryCount).toBe(0);
  });

  it("does not collapse logs with same nodeId but different iterationIndex", () => {
    const logs = [
      makeLog({
        nodeId: "write-1",
        status: "success",
        iterationIndex: 0,
        forEachNodeId: "fe-1",
      }),
      makeLog({
        nodeId: "write-1",
        status: "success",
        iterationIndex: 1,
        forEachNodeId: "fe-1",
      }),
      makeLog({
        nodeId: "write-1",
        status: "success",
        iterationIndex: 2,
        forEachNodeId: "fe-1",
      }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(3);
    for (const entry of result) {
      expect(entry.retryCount).toBe(0);
    }
  });

  it("collapses retries within the same iteration", () => {
    const logs = [
      makeLog({
        nodeId: "write-1",
        status: "error",
        iterationIndex: 0,
        forEachNodeId: "fe-1",
      }),
      makeLog({
        nodeId: "write-1",
        status: "success",
        iterationIndex: 0,
        forEachNodeId: "fe-1",
      }),
      makeLog({
        nodeId: "write-1",
        status: "success",
        iterationIndex: 1,
        forEachNodeId: "fe-1",
      }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(2);
    expect(result[0].retryCount).toBe(1);
    expect(result[0].iterationIndex).toBe(0);
    expect(result[1].retryCount).toBe(0);
    expect(result[1].iterationIndex).toBe(1);
  });

  it("does not collapse logs with same nodeId but different forEachNodeId", () => {
    const logs = [
      makeLog({ nodeId: "write-1", status: "success", forEachNodeId: "fe-1" }),
      makeLog({ nodeId: "write-1", status: "success", forEachNodeId: "fe-2" }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(2);
    for (const entry of result) {
      expect(entry.retryCount).toBe(0);
    }
  });

  it("preserves insertion order based on first occurrence", () => {
    const logs = [
      makeLog({ nodeId: "a", status: "success" }),
      makeLog({ nodeId: "b", status: "error" }),
      makeLog({ nodeId: "b", status: "success" }),
      makeLog({ nodeId: "c", status: "success" }),
    ];

    const result = collapseRetries(logs);

    expect(result.map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("does not collapse multiple successful runs of the same node", () => {
    const logs = [
      makeLog({
        nodeId: "write-1",
        status: "success",
        startedAt: new Date("2025-01-01T00:00:01Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "success",
        startedAt: new Date("2025-01-01T00:00:02Z"),
      }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(2);
    for (const entry of result) {
      expect(entry.retryCount).toBe(0);
    }
  });

  it("selects the latest attempt when logs arrive in reverse chronological order", () => {
    const logs = [
      makeLog({
        nodeId: "write-1",
        status: "success",
        startedAt: new Date("2025-01-01T00:00:03Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:02Z"),
      }),
      makeLog({
        nodeId: "write-1",
        status: "error",
        startedAt: new Date("2025-01-01T00:00:01Z"),
      }),
    ];

    const result = collapseRetries(logs);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("success");
    expect(result[0].retryCount).toBe(2);
    expect(result[0].retryLogs?.[0].startedAt).toEqual(
      new Date("2025-01-01T00:00:01Z")
    );
    expect(result[0].retryLogs?.[1].startedAt).toEqual(
      new Date("2025-01-01T00:00:02Z")
    );
  });
});
