// KEEP-581: pin the rethrow contract on syncWorkflowSchedule.
//
// The function's try/catch around extractScheduleConfig only catches
// IntervalTooSmallError -- any other thrown error must propagate to
// the caller so a real bug (RangeError, generic Error, anything new
// the parser might throw in future) surfaces loudly instead of
// silently demoting to a `synced: false` failure.
//
// We exercise this by mocking parseIntervalSeconds (the only thing
// inside extractScheduleConfig that currently throws) to throw a
// generic Error and asserting the promise rejects.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockParseIntervalSeconds } = vi.hoisted(() => ({
  mockParseIntervalSeconds: vi.fn(),
}));

vi.mock("@/lib/cron-utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/cron-utils")>(
      "@/lib/cron-utils"
    );
  return {
    ...actual,
    parseIntervalSeconds: mockParseIntervalSeconds,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowSchedules: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowSchedules: { workflowId: "workflow_id" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { INFRASTRUCTURE: "INFRASTRUCTURE" },
  logSystemError: vi.fn(),
}));

import type { WorkflowNode } from "@/lib/workflow/store";

function scheduleNodeWithInterval(): WorkflowNode[] {
  return [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        type: "trigger",
        label: "Schedule",
        config: {
          triggerType: "Schedule",
          scheduleIntervalSeconds: 300,
          scheduleTimezone: "UTC",
        },
      },
    },
  ] as unknown as WorkflowNode[];
}

describe("syncWorkflowSchedule error propagation (KEEP-581)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rethrows non-IntervalTooSmallError errors from parseIntervalSeconds", async () => {
    mockParseIntervalSeconds.mockImplementation(() => {
      throw new Error("synthetic parser failure");
    });

    const { syncWorkflowSchedule } = await import("@/lib/schedule-service");

    await expect(
      syncWorkflowSchedule("wf_rethrow_test", scheduleNodeWithInterval())
    ).rejects.toThrow("synthetic parser failure");
  });

  it("rethrows custom error subclasses that are not IntervalTooSmallError", async () => {
    class SyntheticOtherError extends Error {
      constructor() {
        super("synthetic other error");
        this.name = "SyntheticOtherError";
      }
    }
    mockParseIntervalSeconds.mockImplementation(() => {
      throw new SyntheticOtherError();
    });

    const { syncWorkflowSchedule } = await import("@/lib/schedule-service");

    await expect(
      syncWorkflowSchedule("wf_rethrow_test", scheduleNodeWithInterval())
    ).rejects.toBeInstanceOf(SyntheticOtherError);
  });

  it("converts IntervalTooSmallError to a hard sync failure (does NOT rethrow)", async () => {
    // Sanity: confirm the catch arm for IntervalTooSmallError still works
    // -- otherwise the rethrow tests above are passing for the wrong
    // reason (e.g. the catch block was deleted entirely).
    const { IntervalTooSmallError } = await import("@/lib/cron-utils");
    mockParseIntervalSeconds.mockImplementation(() => {
      throw new IntervalTooSmallError(30);
    });

    const { syncWorkflowSchedule } = await import("@/lib/schedule-service");

    const result = await syncWorkflowSchedule(
      "wf_rethrow_test",
      scheduleNodeWithInterval()
    );

    expect(result.synced).toBe(false);
    if (!result.synced) {
      expect(result.kind).toBe("hard");
      if (result.kind === "hard") {
        expect(result.code).toBe("interval_too_small");
      }
    }
  });
});
