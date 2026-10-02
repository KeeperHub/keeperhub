import { beforeEach, describe, expect, it, vi } from "vitest";

// Every action step runs through withStepLogging. A result larger than the
// stored-output limit is turned into a failed step there, before it is
// persisted or handed back to the executor.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/metrics/instrumentation/workflow", () => ({
  recordStepMetrics: vi.fn(),
}));
vi.mock("@/lib/workflow/executor/step-claim", () => ({
  acquireStepClaim: vi.fn(() => Promise.resolve({ outcome: "run" })),
  releaseStepClaim: vi.fn(() => Promise.resolve()),
  stepClaimScope: vi.fn((scope: unknown) => scope),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  incrementCompletedSteps: vi.fn(),
  logStepCompleteDb: vi.fn(),
  logStepStartDb: vi.fn(),
  logWorkflowCompleteDb: vi.fn(),
  updateCurrentStep: vi.fn(),
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { recordStepMetrics } from "@/lib/metrics/instrumentation/workflow";
import {
  incrementCompletedSteps,
  logStepCompleteDb,
  logStepStartDb,
} from "@/lib/workflow/executor/logging";
import {
  type StepContext,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { STEP_OUTPUT_TOO_LARGE_CODE } from "@/lib/workflow/executor/stored-output-cap";
import { MAX_STORED_OUTPUT_BYTES } from "@/lib/workflow/output-limits";

const context: StepContext = {
  executionId: "exec-1",
  nodeId: "node-1",
  nodeName: "Get latest 3 execution details",
  nodeType: "http-request",
};

describe("withStepLogging stored-output cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logStepStartDb).mockResolvedValue({
      logId: "log-1",
      startTime: Date.now(),
    });
  });

  it("fails a result larger than the limit before persisting it", async () => {
    const huge = {
      success: true,
      data: { results: "x".repeat(MAX_STORED_OUTPUT_BYTES) },
    };

    const result = (await withStepLogging({ _context: context }, () =>
      Promise.resolve(huge)
    )) as {
      success: boolean;
      error?: string;
      code?: string;
      errorClass?: ExecutionErrorType;
    };

    expect(result.success).toBe(false);
    expect(result.code).toBe(STEP_OUTPUT_TOO_LARGE_CODE);
    expect(result.error).toMatch(/exceeds the 1\.0 MiB limit/);
    // The executor forwards this tag to the run finaliser, which is what
    // keeps the run a plain error rather than a paging system_error.
    expect(result.errorClass).toBe(ExecutionErrorType.USER);

    const completion = vi.mocked(logStepCompleteDb).mock.calls[0]?.[0];
    expect(completion?.status).toBe("error");
    expect(completion?.error).toBe(result.error);
    // The persisted output is the failed result, not the oversized data.
    expect(completion?.output).toEqual(result);
    expect(completion?.outputRaw).toEqual(result);

    expect(incrementCompletedSteps).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
    expect(recordStepMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: STEP_OUTPUT_TOO_LARGE_CODE,
      })
    );
  });

  it("leaves a result within the limit untouched", async () => {
    const small = { success: true, data: { count: 3 } };
    const result = await withStepLogging({ _context: context }, () =>
      Promise.resolve(small)
    );
    expect(result).toBe(small);
    expect(vi.mocked(logStepCompleteDb).mock.calls[0]?.[0]?.status).toBe(
      "success"
    );
  });
});
