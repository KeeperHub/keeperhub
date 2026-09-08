import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db/schema", () => ({
  workflows: {},
  workflowExecutions: {
    id: "workflowExecutions.id",
    status: "workflowExecutions.status",
  },
  workflowSchedules: {
    id: "workflowSchedules.id",
    intervalSeconds: "workflowSchedules.intervalSeconds",
    anchorAt: "workflowSchedules.anchorAt",
    cronExpression: "workflowSchedules.cronExpression",
    timezone: "workflowSchedules.timezone",
    runCount: "workflowSchedules.runCount",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
  notInArray: () => ({}),
}));

vi.mock("cron-parser", () => ({
  CronExpressionParser: {
    parse: vi.fn().mockReturnValue({
      next: vi.fn().mockReturnValue({
        toDate: vi.fn().mockReturnValue(new Date("2025-06-01T00:00:00Z")),
      }),
    }),
  },
}));

vi.mock("../../lib/workflow/executor/progress", () => ({
  calculateTotalSteps: vi.fn().mockReturnValue(3),
}));

vi.mock("../../lib/workflow/store", () => ({}));

// updateExecutionStatus now classifies the error, and classifyExecutionError's
// default branch reads DEFAULT_SYSTEM_ERROR_CODE, so the mock must provide it.
vi.mock("../../lib/errors/error-codes", () => ({
  DEFAULT_SYSTEM_ERROR_CODE: "C-0001",
}));

vi.mock("../../keeperhub-executor/lib/serialize", () => ({
  toJsonSafe: (v: unknown) => v,
}));

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbSchema } from "../../keeperhub-executor/lib/db-helpers";
import { applyExecutionResult } from "../../keeperhub-executor/lib/db-helpers";

function makeMockDb(scheduleRow?: object | null): PostgresJsDatabase<DbSchema> {
  // where() must be awaitable (updateScheduleStatus awaits it directly) AND
  // expose .returning() (updateExecutionStatus chains it for the terminal
  // counter gate). Modeled as a custom thenable; returning [] means "no row
  // flipped" so no counter emission is attempted.
  const mockWhere = vi.fn().mockImplementation(() => {
    const promise = Promise.resolve([]);
    return {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable mocking Drizzle's query builder
      then: (
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => promise.then(onFulfilled, onRejected),
      catch: (onRejected: (reason: unknown) => unknown) =>
        promise.catch(onRejected),
      returning: vi.fn().mockResolvedValue([]),
    };
  });
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  const mockFindFirst = vi.fn().mockResolvedValue(
    scheduleRow === undefined
      ? {
          id: "sched-1",
          cronExpression: "0 * * * *",
          timezone: "UTC",
          intervalSeconds: null,
          anchorAt: null,
          runCount: "5",
        }
      : scheduleRow
  );

  return {
    update: mockUpdate,
    query: {
      workflowSchedules: { findFirst: mockFindFirst },
    },
  } as unknown as PostgresJsDatabase<DbSchema>;
}

type MockDb = ReturnType<typeof makeMockDb> & {
  query: { workflowSchedules: { findFirst: ReturnType<typeof vi.fn> } };
};

const SUCCESS_RESULT = {
  success: true,
  results: {},
  outputs: { "step-1": { label: "Result", data: "done" } },
} as unknown as Awaited<
  ReturnType<
    typeof import("../../lib/workflow/executor/executor.workflow").executeWorkflow
  >
>;

const FAILURE_RESULT = {
  success: false,
  results: {},
  outputs: {},
  error: "Step failed: timeout",
} as unknown as Awaited<
  ReturnType<
    typeof import("../../lib/workflow/executor/executor.workflow").executeWorkflow
  >
>;

const FAILURE_RESULT_FROM_STEP = {
  success: false,
  results: {
    "step-1": { success: false, error: "Contract reverted" },
    "step-2": { success: true },
  },
  outputs: {},
} as unknown as Awaited<
  ReturnType<
    typeof import("../../lib/workflow/executor/executor.workflow").executeWorkflow
  >
>;

describe("applyExecutionResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("successful execution", () => {
    it("returns null errorMessage on success", async () => {
      const db = makeMockDb(null);
      const result = await applyExecutionResult(
        db,
        "exec-1",
        SUCCESS_RESULT,
        {}
      );
      expect(result.errorMessage).toBeNull();
    });

    it("does not call updateScheduleStatus when no scheduleId", async () => {
      const db = makeMockDb(null) as MockDb;
      await applyExecutionResult(db, "exec-1", SUCCESS_RESULT, {});
      expect(db.query.workflowSchedules.findFirst).not.toHaveBeenCalled();
    });

    it("calls updateScheduleStatus when scheduleId is provided", async () => {
      const db = makeMockDb() as MockDb;
      await applyExecutionResult(db, "exec-1", SUCCESS_RESULT, {
        scheduleId: "sched-1",
      });
      expect(db.query.workflowSchedules.findFirst).toHaveBeenCalled();
    });
  });

  describe("failed execution", () => {
    it("returns the top-level error message from result.error", async () => {
      const db = makeMockDb(null);
      const result = await applyExecutionResult(
        db,
        "exec-1",
        FAILURE_RESULT,
        {}
      );
      expect(result.errorMessage).toBe("Step failed: timeout");
    });

    it("falls back to step-level error when result.error is absent", async () => {
      const db = makeMockDb(null);
      const result = await applyExecutionResult(
        db,
        "exec-1",
        FAILURE_RESULT_FROM_STEP,
        {}
      );
      expect(result.errorMessage).toBe("Contract reverted");
    });

    it("falls back to 'Unknown error' when no error field is present", async () => {
      const db = makeMockDb(null);
      const noErrorResult = {
        success: false,
        results: {},
        outputs: {},
      } as unknown as Awaited<
        ReturnType<
          typeof import("../../lib/workflow/executor/executor.workflow").executeWorkflow
        >
      >;
      const result = await applyExecutionResult(
        db,
        "exec-1",
        noErrorResult,
        {}
      );
      expect(result.errorMessage).toBe("Unknown error");
    });

    it("calls updateScheduleStatus when scheduleId is provided on failure", async () => {
      const db = makeMockDb() as MockDb;
      await applyExecutionResult(db, "exec-1", FAILURE_RESULT, {
        scheduleId: "sched-1",
      });
      expect(db.query.workflowSchedules.findFirst).toHaveBeenCalled();
    });

    it("does not call updateScheduleStatus when scheduleId is absent on failure", async () => {
      const db = makeMockDb(null) as MockDb;
      await applyExecutionResult(db, "exec-1", FAILURE_RESULT, {});
      expect(db.query.workflowSchedules.findFirst).not.toHaveBeenCalled();
    });
  });
});
