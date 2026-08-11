/**
 * KEEP-468 follow-up: per-node failure log is persisted when
 * TemplateResolutionError aborts a step before its handler ever runs.
 *
 * Why this is needed: the workflow body has `"use workflow"`, which forbids
 * Node.js modules in its bundle (postgres driver, nanoid, etc.). The catch
 * block in executeNode therefore cannot call the DB layer directly; it
 * routes through `triggerStep` (`"use step"`) using the new
 * `_recordStepFailure` mode. Without that step log row, the
 * KEEP-1549/KEEP-431 reconciler inside `logWorkflowCompleteDb` sees no
 * failed node and CAS-flips the workflow status from 'error' to 'success'
 * as a "spurious SDK retry," masking the runtime fail-closed completely.
 *
 * Coverage:
 *   - triggerStep with `_recordStepFailure` writes a workflow_execution_logs
 *     row at status='error' (start + complete pair, mirroring withStepLogging)
 *   - bypasses the normal trigger execution path
 *   - graceful when logStepStartDb returns an empty logId (cancelled / terminal)
 *   - leaves _workflowComplete handling intact
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const logStepStartDb = vi.fn();
const logStepCompleteDb = vi.fn();
const logWorkflowComplete = vi.fn();

vi.mock("@/lib/workflow/executor/logging", () => ({
  logStepStartDb,
  logStepCompleteDb,
}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  logWorkflowComplete,
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

const { triggerStep } = await import("@/lib/workflow/nodes/trigger/step");

describe("triggerStep _recordStepFailure (KEEP-468)", () => {
  beforeEach(() => {
    logStepStartDb.mockReset();
    logStepCompleteDb.mockReset();
    logWorkflowComplete.mockReset();
  });

  it("writes a start+complete pair with status='error'", async () => {
    logStepStartDb.mockResolvedValueOnce({ logId: "log-1", startTime: 100 });
    logStepCompleteDb.mockResolvedValueOnce(undefined);

    await triggerStep({
      triggerData: {},
      _recordStepFailure: {
        executionId: "exec-1",
        nodeId: "action_1",
        nodeName: "Add Person",
        nodeType: "action",
        error: "Unresolved template reference(s): {{$trigger.input.ts}}",
      },
    });

    expect(logStepStartDb).toHaveBeenCalledWith({
      executionId: "exec-1",
      nodeId: "action_1",
      nodeName: "Add Person",
      nodeType: "action",
      input: undefined,
    });
    expect(logStepCompleteDb).toHaveBeenCalledWith({
      logId: "log-1",
      startTime: 100,
      status: "error",
      error: "Unresolved template reference(s): {{$trigger.input.ts}}",
      executionId: "exec-1",
    });
  });

  it("does not invoke the trigger execution path", async () => {
    logStepStartDb.mockResolvedValueOnce({ logId: "log-2", startTime: 0 });
    logStepCompleteDb.mockResolvedValueOnce(undefined);

    const result = await triggerStep({
      triggerData: { willNotBeUsed: true },
      _recordStepFailure: {
        executionId: "exec-2",
        nodeId: "n1",
        nodeName: "n1",
        nodeType: "action",
        error: "boom",
      },
    });

    // Returns the empty-data sentinel, NOT the trigger payload.
    expect(result).toEqual({ success: true, data: {} });
    expect(logWorkflowComplete).not.toHaveBeenCalled();
  });

  it("skips the complete write when logStepStartDb returned an empty logId (cancelled execution)", async () => {
    logStepStartDb.mockResolvedValueOnce({ logId: "", startTime: 0 });

    await triggerStep({
      triggerData: {},
      _recordStepFailure: {
        executionId: "exec-3",
        nodeId: "n1",
        nodeName: "n1",
        nodeType: "action",
        error: "boom",
      },
    });

    expect(logStepStartDb).toHaveBeenCalledTimes(1);
    expect(logStepCompleteDb).not.toHaveBeenCalled();
  });

  it("still routes _workflowComplete through logWorkflowComplete (regression guard)", async () => {
    await triggerStep({
      triggerData: {},
      _workflowComplete: {
        executionId: "exec-4",
        status: "error",
        error: "x",
        startTime: 0,
      },
    });

    expect(logWorkflowComplete).toHaveBeenCalledWith({
      executionId: "exec-4",
      status: "error",
      error: "x",
      startTime: 0,
    });
    expect(logStepStartDb).not.toHaveBeenCalled();
  });
});
