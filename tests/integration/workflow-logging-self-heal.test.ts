/**
 * KEEP-431 follow-up: self-healing reconciliation when a step success commit
 * lands AFTER the workflow has been finalized to a spurious error (cross-pod
 * race observed in prod execution joc7il55352vuya0ww9tl).
 *
 * These tests exercise selfHealWorkflowAfterLateStepCommit end-to-end via
 * logStepCompleteDb -- the public entry point that triggers it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    WORKFLOW_ENGINE: "workflow_engine",
    DATABASE: "database",
  },
  logSystemError: vi.fn(),
}));

const { mockIncrementCounter } = vi.hoisted(() => ({
  mockIncrementCounter: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: mockIncrementCounter,
    recordLatency: vi.fn(),
  }),
}));

const { workflowExecutionsMock, workflowExecutionLogsMock } = vi.hoisted(
  () => ({
    workflowExecutionsMock: {
      id: "id",
      status: "status",
      error: "error",
      output: "output",
      completedAt: "completed_at",
      duration: "duration",
      startedAt: "started_at",
      currentNodeId: "current_node_id",
      currentNodeName: "current_node_name",
    },
    workflowExecutionLogsMock: {
      id: "id",
      executionId: "execution_id",
      nodeId: "node_id",
      logId: "log_id",
      status: "status",
      output: "output",
      outputRaw: "output_raw",
      error: "error",
      completedAt: "completed_at",
      duration: "duration",
    },
  })
);

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: workflowExecutionsMock,
  workflowExecutionLogs: workflowExecutionLogsMock,
}));

type ExecRow = {
  status: string;
  error: string | null;
  completedAt: Date | null;
  startedAt?: Date | null;
};
type LogRow = {
  nodeId: string;
  status: string;
  iterationIndex?: number | null;
  forEachNodeId?: string | null;
};
type UpdateCall = {
  target: unknown;
  set: Record<string, unknown>;
};

let executionRow: ExecRow | undefined;
let allLogs: LogRow[] = [];
let updateCalls: UpdateCall[] = [];

type WhereChain = Promise<{ rowCount?: number } | undefined>;
type SetChain = { where: () => WhereChain };
type UpdateChain = { set: (values: Record<string, unknown>) => SetChain };

function buildUpdate(target: unknown): UpdateChain {
  return {
    set: (values: Record<string, unknown>): SetChain => {
      updateCalls.push({ target, set: values });
      // The CAS update on workflow_executions returns rowCount=1 if the
      // status was still 'error' at update time, 0 otherwise. Tests can
      // override by mutating executionRow before the call.
      if (target === workflowExecutionsMock) {
        const flipped =
          executionRow !== undefined && executionRow.status === "error";
        if (flipped && executionRow !== undefined) {
          executionRow.status =
            (values.status as string) ?? executionRow.status;
        }
        return {
          where: (): WhereChain =>
            Promise.resolve({ rowCount: flipped ? 1 : 0 }),
        };
      }
      return {
        where: (): WhereChain => Promise.resolve(undefined),
      };
    },
  };
}

// Production listTrulyFailedNodes filters out iteration rows; our findMany mock
// does the same so tests can populate forEach iteration rows in `allLogs` and
// verify they are excluded from self-heal aggregation.
function filterTopLevelLogs(rows: LogRow[]): LogRow[] {
  return rows.filter(
    (r) =>
      (r.iterationIndex === null || r.iterationIndex === undefined) &&
      (r.forEachNodeId === null || r.forEachNodeId === undefined)
  );
}

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutions: {
        findFirst: vi.fn(() => Promise.resolve(executionRow)),
      },
      workflowExecutionLogs: {
        findMany: vi.fn(() => Promise.resolve(filterTopLevelLogs(allLogs))),
      },
    },
    update: vi.fn((target: unknown) => buildUpdate(target)),
  },
}));

import { logStepCompleteDb } from "@/lib/workflow/executor/logging";

function getWorkflowStatusFlip(): UpdateCall | undefined {
  return updateCalls.find(
    (c) =>
      c.target === workflowExecutionsMock &&
      (c.set.status === "success" || c.set.status === "error")
  );
}

function getStaleErrorClear(): UpdateCall | undefined {
  return updateCalls.find(
    (c) =>
      c.target === workflowExecutionLogsMock &&
      Object.keys(c.set).length === 1 &&
      c.set.error === null
  );
}

describe("logStepCompleteDb self-heal (KEEP-431 follow-up)", () => {
  const executionId = "exec-keep-431-followup";

  beforeEach(() => {
    executionRow = undefined;
    allLogs = [];
    updateCalls = [];
    mockIncrementCounter.mockReset();
  });

  // Restore the default db.update implementation after each test so any
  // mockImplementation override (e.g. in the CAS-guard test) doesn't leak
  // to subsequent tests.
  afterEach(async () => {
    const { db } = await import("@/lib/db");
    (db.update as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (target: unknown) => buildUpdate(target)
    );
  });

  describe("triggers self-heal when workflow is parked in spurious error", () => {
    it("flips workflow status to success when this commit completes the picture", async () => {
      // Workflow was finalized to error before this commit landed
      executionRow = {
        status: "error",
        error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 5000),
      };
      // After this commit, every node has a success row
      allLogs = [
        { nodeId: "trigger", status: "success" },
        { nodeId: "read1", status: "success" },
        { nodeId: "read2", status: "success" },
        { nodeId: "combine", status: "success" },
      ];

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 200,
        status: "success",
        output: { merged: true },
        outputRaw: { merged: true },
        executionId,
      });

      const flip = getWorkflowStatusFlip();
      expect(flip).toBeDefined();
      expect(flip?.set).toEqual(
        expect.objectContaining({
          status: "success",
          error: null,
        })
      );
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({ outcome: "flipped" })
      );
    });

    it("clears stale error from success rows after flip", async () => {
      executionRow = {
        status: "error",
        error: "Step did not record completion",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      // Combine row has both status='success' and the stale STEP_INCOMPLETE_ERROR
      // attached by closeOrphanedRunningLogs (this is the prod KEEP-431 paradox)
      allLogs = [
        { nodeId: "trigger", status: "success" },
        { nodeId: "combine", status: "success" },
      ];

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 200,
        status: "success",
        output: {},
        outputRaw: {},
        executionId,
      });

      const clearCall = getStaleErrorClear();
      expect(clearCall).toBeDefined();
      expect(clearCall?.set.error).toBeNull();
    });

    it("flips for the 'failed after N retries' spurious shape", async () => {
      executionRow = {
        status: "error",
        error: 'Step "combine" failed after 0 retries: state replay mismatch',
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      allLogs = [{ nodeId: "combine", status: "success" }];

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      expect(getWorkflowStatusFlip()?.set.status).toBe("success");
    });
  });

  describe("does not self-heal when conditions don't apply", () => {
    it("no-op when workflow is already in success state (idempotent)", async () => {
      executionRow = {
        status: "success",
        error: null,
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };

      await logStepCompleteDb({
        logId: "log_x",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      // Only the row UPDATE for the step log itself, no workflow_executions UPDATE
      const wfUpdates = updateCalls.filter(
        (c) => c.target === workflowExecutionsMock
      );
      expect(wfUpdates).toHaveLength(0);
      // Does not flip; emits the early-exit observability metric instead.
      expect(mockIncrementCounter).not.toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({ outcome: "flipped" })
      );
    });

    it("no-op when workflow status is cancelled", async () => {
      executionRow = {
        status: "cancelled",
        error: null,
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };

      await logStepCompleteDb({
        logId: "log_x",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      const wfUpdates = updateCalls.filter(
        (c) => c.target === workflowExecutionsMock
      );
      expect(wfUpdates).toHaveLength(0);
    });

    it("no-op when error is genuine (not spurious)", async () => {
      executionRow = {
        status: "error",
        error: "Contract reverted: insufficient balance",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      allLogs = [{ nodeId: "combine", status: "success" }];

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      const wfUpdates = updateCalls.filter(
        (c) => c.target === workflowExecutionsMock
      );
      expect(wfUpdates).toHaveLength(0);
      // Does not flip a genuine error -- this is the safety guarantee that
      // prevents self-heal from masking real step failures.
      expect(mockIncrementCounter).not.toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({ outcome: "flipped" })
      );
    });

    it("no-op when at least one node still has only running/error rows", async () => {
      executionRow = {
        status: "error",
        error: "exceeded max retries",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      // node_b genuinely failed: only error rows, no success
      allLogs = [
        { nodeId: "node_a", status: "success" },
        { nodeId: "node_b", status: "error" },
      ];

      await logStepCompleteDb({
        logId: "log_a",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      const wfUpdates = updateCalls.filter(
        (c) => c.target === workflowExecutionsMock
      );
      expect(wfUpdates).toHaveLength(0);
    });

    it("no-op when workflow has not been finalized yet (completedAt null)", async () => {
      executionRow = {
        status: "error",
        error: "exceeded max retries",
        completedAt: null,
        startedAt: new Date(Date.now() - 1000),
      };
      allLogs = [{ nodeId: "combine", status: "success" }];

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      const wfUpdates = updateCalls.filter(
        (c) => c.target === workflowExecutionsMock
      );
      expect(wfUpdates).toHaveLength(0);
    });

    it("does not self-heal on error-status step commits", async () => {
      executionRow = {
        status: "error",
        error: "exceeded max retries",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      allLogs = [{ nodeId: "combine", status: "error" }];

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 100,
        status: "error",
        error: "step failed",
        executionId,
      });

      const wfUpdates = updateCalls.filter(
        (c) => c.target === workflowExecutionsMock
      );
      expect(wfUpdates).toHaveLength(0);
    });

    it("no-op when executionId is missing", async () => {
      // No executionId -- self-heal cannot run
      executionRow = {
        status: "error",
        error: "exceeded max retries",
        completedAt: new Date(),
      };

      await logStepCompleteDb({
        logId: "log_x",
        startTime: Date.now() - 100,
        status: "success",
      });

      const wfUpdates = updateCalls.filter(
        (c) => c.target === workflowExecutionsMock
      );
      expect(wfUpdates).toHaveLength(0);
    });
  });

  describe("error column hygiene on success commits", () => {
    it("clears the error column on success rows (force null, not undefined skip)", async () => {
      executionRow = {
        status: "success",
        error: null,
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };

      await logStepCompleteDb({
        logId: "log_x",
        startTime: Date.now() - 100,
        status: "success",
        output: { ok: true },
        outputRaw: { ok: true },
        executionId,
      });

      // The first UPDATE on workflowExecutionLogs is the success commit
      const stepUpdate = updateCalls.find(
        (c) => c.target === workflowExecutionLogsMock
      );
      expect(stepUpdate).toBeDefined();
      expect(stepUpdate?.set.status).toBe("success");
      // error must be explicitly null (not undefined) so Drizzle includes it
      // in the UPDATE and overwrites any stale STEP_INCOMPLETE_ERROR
      expect(stepUpdate?.set.error).toBeNull();
    });

    it("preserves user-supplied error on error-status commits", async () => {
      executionRow = {
        status: "running",
        error: null,
        completedAt: null,
        startedAt: new Date(),
      };

      await logStepCompleteDb({
        logId: "log_x",
        startTime: Date.now() - 100,
        status: "error",
        error: "Contract reverted",
        executionId,
      });

      const stepUpdate = updateCalls.find(
        (c) => c.target === workflowExecutionLogsMock
      );
      expect(stepUpdate?.set.error).toBe("Contract reverted");
    });
  });

  describe("forEach iteration row filtering", () => {
    it("ignores iteration log rows when aggregating top-level node status", async () => {
      // Workflow finalized to spurious error. Top-level forEach node has a
      // success row. Iteration rows for the body steps include a failed one,
      // but those must NOT block self-heal -- iteration failures are the
      // forEach runner's responsibility to surface via the parent node row.
      executionRow = {
        status: "error",
        error: "exceeded max retries",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 5000),
      };
      allLogs = [
        { nodeId: "trigger", status: "success" },
        { nodeId: "loop", status: "success" },
        // Iteration rows for `loop` body -- one error, but iteration logs are
        // scoped under the parent and must not flow into self-heal aggregation
        {
          nodeId: "body",
          status: "success",
          iterationIndex: 0,
          forEachNodeId: "loop",
        },
        {
          nodeId: "body",
          status: "error",
          iterationIndex: 1,
          forEachNodeId: "loop",
        },
      ];

      await logStepCompleteDb({
        logId: "log_loop",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      // Iteration error should NOT block the flip
      const flip = getWorkflowStatusFlip();
      expect(flip).toBeDefined();
      expect(flip?.set.status).toBe("success");
    });
  });

  describe("early-exit observability", () => {
    // Note: an "execution_missing" reason is unreachable from logStepCompleteDb
    // because isExecutionTerminal early-returns when findFirst yields undefined,
    // skipping self-heal entirely. The reason exists on selfHealWorkflowAfterLateStepCommit
    // for callers that bypass that guard, but is not exercised by the normal flow.

    it("emits noop_early_exit with reason=not_finalized when completedAt is null", async () => {
      executionRow = {
        status: "running",
        error: null,
        completedAt: null,
        startedAt: new Date(),
      };

      await logStepCompleteDb({
        logId: "log_x",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({
          outcome: "noop_early_exit",
          reason: "not_finalized",
        })
      );
    });

    it("emits noop_early_exit with reason=status_not_error for already-success workflows", async () => {
      executionRow = {
        status: "success",
        error: null,
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };

      await logStepCompleteDb({
        logId: "log_x",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({
          outcome: "noop_early_exit",
          reason: "status_not_error",
        })
      );
    });

    it("emits noop_early_exit with reason=error_not_spurious for genuine errors", async () => {
      executionRow = {
        status: "error",
        error: "Contract reverted: insufficient balance",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      allLogs = [{ nodeId: "combine", status: "success" }];

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({
          outcome: "noop_early_exit",
          reason: "error_not_spurious",
        })
      );
    });

    it("emits noop_early_exit with reason=real_failures_present when a node truly failed", async () => {
      executionRow = {
        status: "error",
        error: "exceeded max retries",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      allLogs = [
        { nodeId: "node_a", status: "success" },
        { nodeId: "node_b", status: "error" },
      ];

      await logStepCompleteDb({
        logId: "log_a",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({
          outcome: "noop_early_exit",
          reason: "real_failures_present",
        })
      );
    });
  });

  describe("CAS guard against double-flip", () => {
    it("emits noop_status_changed metric when CAS UPDATE affects 0 rows", async () => {
      // Simulate: a concurrent self-heal flipped status from 'error' to
      // 'success' between our findFirst read and our UPDATE WHERE
      // status='error' clause. We force this by overriding the update mock
      // on workflow_executions to always return rowCount=0.
      executionRow = {
        status: "error",
        error: "exceeded max retries",
        completedAt: new Date(),
        startedAt: new Date(Date.now() - 1000),
      };
      allLogs = [{ nodeId: "combine", status: "success" }];

      const { db } = await import("@/lib/db");
      const dbUpdate = db.update as unknown as ReturnType<typeof vi.fn>;
      dbUpdate.mockImplementation((target: unknown) => ({
        set: (values: Record<string, unknown>): SetChain => {
          updateCalls.push({ target, set: values });
          // Workflow status UPDATE always reports rowCount=0 (CAS missed).
          // Step log UPDATE returns void.
          if (target === workflowExecutionsMock) {
            return {
              where: (): WhereChain => Promise.resolve({ rowCount: 0 }),
            };
          }
          return {
            where: (): WhereChain => Promise.resolve(undefined),
          };
        },
      }));

      await logStepCompleteDb({
        logId: "log_combine",
        startTime: Date.now() - 100,
        status: "success",
        executionId,
      });

      // CAS missed -> production emits noop_status_changed
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({ outcome: "noop_status_changed" })
      );
      // And does NOT emit flipped
      expect(mockIncrementCounter).not.toHaveBeenCalledWith(
        "workflow.executor.self_heal_late_commit.total",
        expect.objectContaining({ outcome: "flipped" })
      );
    });
  });
});
