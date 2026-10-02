import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-only guard module loads "server-only"; stub it for vitest.
vi.mock("server-only", () => ({}));

const { mockGet, mockSet, mockWithStepLogging } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  // Passthrough: run the step logic directly without the DB logging epilogue.
  mockWithStepLogging: vi.fn(
    (_input: unknown, fn: () => unknown) => fn() as unknown
  ),
}));

vi.mock("@/lib/workflow/nodes/workflow-state/store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/workflow/nodes/workflow-state/store")
    >();
  return {
    ...actual,
    getWorkflowStateValue: (...args: unknown[]) => mockGet(...args),
    setWorkflowStateValue: (...args: unknown[]) => mockSet(...args),
  };
});

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (...args: unknown[]) =>
    mockWithStepLogging(...(args as [unknown, () => unknown])),
}));

import { stateGetStep } from "@/lib/workflow/nodes/state-get/step";
import { stateSetStep } from "@/lib/workflow/nodes/state-set/step";

function context(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "state-1",
    nodeName: "State Get",
    nodeType: "State Get",
    organizationId: "org_ctx",
    workflowId: "wf_ctx",
    createdBy: "user_creator",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("stateGetStep", () => {
  it("scopes the read from the execution context, not from config", async () => {
    mockGet.mockResolvedValue({
      success: true,
      exists: true,
      value: 4219,
      version: 3,
    });

    const result = await stateGetStep({
      key: "lastScannedBlock",
      // A config-injected workflowId must be ignored: the step can only read
      // the state of the workflow it runs in, so there is no cross-workflow
      // path (mirrors the circuit-breaker steps' context rule).
      workflowId: "wf_evil",
      organizationId: "org_evil",
      _context: context(),
    } as Parameters<typeof stateGetStep>[0]);

    expect(mockGet).toHaveBeenCalledWith(
      { workflowId: "wf_ctx" },
      "lastScannedBlock"
    );
    expect(result).toEqual({
      success: true,
      exists: true,
      value: 4219,
      version: 3,
    });
  });

  it("passes through a missing key as exists=false with version 0", async () => {
    mockGet.mockResolvedValue({
      success: true,
      exists: false,
      value: null,
      version: 0,
    });

    const result = await stateGetStep({
      key: "never-set",
      _context: context(),
    });

    // version must be present so a downstream State Get.version reference
    // resolves on the first run, and 0 keeps the first write a CAS.
    expect(result).toEqual({
      success: true,
      exists: false,
      value: null,
      version: 0,
    });
  });

  it("fails the step when there is no workflow context", async () => {
    const result = await stateGetStep({
      key: "k",
      _context: context({ workflowId: undefined }),
    });

    expect(mockGet).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error:
        "State Get requires the workflow execution context; it can only run inside a workflow",
    });
  });

  it("surfaces the store's validation error for an empty key", async () => {
    // Key validation lives in the store (single source of truth); the step
    // just surfaces the structured failure.
    mockGet.mockResolvedValue({
      success: false,
      error: "State key must be a non-empty string",
      reason: "invalid",
    });

    const result = await stateGetStep({ key: "  ", _context: context() });

    expect(mockGet).toHaveBeenCalledWith({ workflowId: "wf_ctx" }, "  ");
    expect(result).toEqual({
      success: false,
      error: "State key must be a non-empty string",
    });
  });

  it("surfaces store errors", async () => {
    mockGet.mockResolvedValue({
      success: false,
      error: "storage blew up",
      reason: "storage",
    });

    const result = await stateGetStep({ key: "k", _context: context() });

    expect(result).toEqual({ success: false, error: "storage blew up" });
  });
});

describe("stateSetStep", () => {
  it("scopes the write from the execution context and coerces editor strings", async () => {
    mockSet.mockResolvedValue({ success: true, created: true, version: 1 });

    const result = await stateSetStep({
      key: "lastScannedBlock",
      value: 4219,
      ttl: "3600",
      _context: context(),
    });

    expect(mockSet).toHaveBeenCalledWith(
      { workflowId: "wf_ctx" },
      "lastScannedBlock",
      {
        value: 4219,
        ttlSeconds: 3600,
        expectedVersion: undefined,
        executionId: null,
      }
    );
    expect(result).toEqual({ success: true, created: true, version: 1 });
  });

  it("passes expectedVersion through as the compare-and-set value", async () => {
    mockSet.mockResolvedValue({ success: true, created: false, version: 4 });

    await stateSetStep({
      key: "cursor",
      value: 10,
      expectedVersion: "3",
      _context: context({ executionId: "exec_1" }),
    });

    expect(mockSet).toHaveBeenCalledWith({ workflowId: "wf_ctx" }, "cursor", {
      value: 10,
      ttlSeconds: null,
      expectedVersion: 3,
      executionId: "exec_1",
    });
  });

  it("surfaces a compare-and-set conflict as a step error", async () => {
    mockSet.mockResolvedValue({
      success: false,
      error:
        'Compare-and-set failed: key "cursor" changed since it was read (expected version 3, current 4); the next run re-reads it with State Get',
      reason: "conflict",
    });

    const result = await stateSetStep({
      key: "cursor",
      value: 10,
      expectedVersion: 3,
      _context: context(),
    });

    expect(result).toEqual({
      success: false,
      error:
        'Compare-and-set failed: key "cursor" changed since it was read (expected version 3, current 4); the next run re-reads it with State Get',
    });
  });

  it("fails the step when there is no workflow context", async () => {
    const result = await stateSetStep({
      key: "k",
      value: 1,
      _context: context({ workflowId: undefined }),
    });

    expect(mockSet).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error:
        "State Set requires the workflow execution context; it can only run inside a workflow",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
  ])("requires a value (%s)", async (_label, value) => {
    const result = await stateSetStep({ key: "k", value, _context: context() });

    expect(mockSet).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'State Set requires a "value"',
    });
  });

  it("stores an editor-resolved numeric string as a number", async () => {
    mockSet.mockResolvedValue({ success: true, created: true, version: 1 });

    await stateSetStep({ key: "k", value: "4219", _context: context() });

    expect(mockSet).toHaveBeenCalledWith(
      { workflowId: "wf_ctx" },
      "k",
      expect.objectContaining({ value: 4219 })
    );
  });

  it("rejects an invalid ttl before touching storage", async () => {
    const result = await stateSetStep({
      key: "k",
      value: 1,
      ttl: "later",
      _context: context(),
    });

    expect(mockSet).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "ttl must be a number of seconds",
    });
  });

  it("rejects an invalid expectedVersion before touching storage", async () => {
    const result = await stateSetStep({
      key: "k",
      value: 1,
      expectedVersion: -1,
      _context: context(),
    });

    expect(mockSet).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "expectedVersion must be a non-negative integer",
    });
  });
});
