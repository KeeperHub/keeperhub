import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks -- must be defined before any vi.mock() calls
// ---------------------------------------------------------------------------

const { mockDbUpdate, mockDbUpdateSet, mockStart, mockSqsSend } = vi.hoisted(
  () => ({
    mockDbUpdate: vi.fn(),
    mockDbUpdateSet: vi.fn(),
    mockStart: vi.fn(),
    mockSqsSend: vi.fn(),
  })
);

vi.mock("@/lib/db", () => ({
  db: { update: mockDbUpdate },
}));

// Keeps the WORKFLOW_DISPATCH_VIA_EXECUTOR branch from making a real network
// call; that branch is already covered end-to-end by keeperhub-executor's
// own tests and is explicitly out of scope for this fix (it already
// initializes progress correctly via initializeExecutionProgress).
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    send = mockSqsSend;
  },
  SendMessageCommand: class {
    constructor(input: unknown) {
      Object.assign(this as object, input as object);
    }
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", status: "status" },
}));

vi.mock("workflow/api", () => ({
  start: mockStart,
}));

vi.mock("@/lib/workflow/executor/executor.workflow", () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

// finalize-error.ts and its transitive deps are server-only; not exercised on
// the happy path, mocked here purely so the module graph resolves.
vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: vi.fn().mockReturnValue({
    errorCategory: "workflow_engine",
    errorType: "system",
    code: "unknown",
  }),
  isDefaultClassification: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn().mockResolvedValue(undefined),
}));

import { executeWorkflowInBackground } from "@/lib/workflow/execute-in-background";

describe("executeWorkflowInBackground - progress initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WORKFLOW_DISPATCH_VIA_EXECUTOR", "");
    mockDbUpdateSet.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockDbUpdate.mockReturnValue({ set: mockDbUpdateSet });
    mockStart.mockResolvedValue({ runId: "run-1" });
    mockSqsSend.mockResolvedValue({ MessageId: "msg-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("initializes totalSteps from the workflow graph before start() is called (default/fallback dispatch path)", async () => {
    const callOrder: string[] = [];
    mockDbUpdateSet.mockImplementation((values: Record<string, unknown>) => {
      if ("totalSteps" in values) {
        callOrder.push("initializeProgress");
      }
      return { where: vi.fn().mockResolvedValue(undefined) };
    });
    mockStart.mockImplementation(() => {
      callOrder.push("start");
      return Promise.resolve({ runId: "run-1" });
    });

    const nodes = [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { type: "trigger", enabled: true },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 0, y: 0 },
        data: { type: "action", enabled: true },
      },
    ];
    const edges = [{ id: "e1", source: "trigger-1", target: "action-1" }];

    await executeWorkflowInBackground(
      "exec-1",
      "wf-1",
      nodes as never,
      edges as never,
      {},
      { logPrefix: "[Test]", endpoint: "/test" }
    );

    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ totalSteps: "2", completedSteps: "0" })
    );
    expect(mockStart).toHaveBeenCalled();

    const progressIdx = callOrder.indexOf("initializeProgress");
    const startIdx = callOrder.indexOf("start");
    expect(progressIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(progressIdx).toBeLessThan(startIdx);
  });

  it("does not initialize progress on the SQS/executor dispatch branch (already handled by initializeExecutionProgress downstream)", async () => {
    vi.stubEnv("WORKFLOW_DISPATCH_VIA_EXECUTOR", "1");
    vi.stubEnv("SQS_QUEUE_URL", "http://sqs.local/queue");
    vi.stubEnv("INTERNAL_SERVICE_HMAC_SECRET", "test-secret");

    await executeWorkflowInBackground(
      "exec-2",
      "wf-2",
      [] as never,
      [] as never,
      {},
      { logPrefix: "[Test]", endpoint: "/test" }
    );

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    // The fallback branch's own progress-init query must not also run here.
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });
});
