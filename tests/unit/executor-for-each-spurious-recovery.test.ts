import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const MAX_RETRIES = (step: string): Error =>
  new Error(`Step "${step}" exceeded max retries (1 retry)`);

const mocks = vi.hoisted(() => ({
  triggerStep: vi.fn(),
  forEachStep: vi.fn(),
  httpRequestStep: vi.fn(),
  collectStep: vi.fn(),
  getCompletedStepOutput: vi.fn(),
  awaitCompletedStepOutputStep: vi.fn(),
  awaitCompletedStepOutputAtIterationStep: vi.fn(),
}));

vi.mock("@/lib/step-registry", () => ({
  getStepImporter: () => undefined,
  getActionLabel: () => undefined,
}));

vi.mock("@/lib/workflow/nodes/trigger/step", () => ({
  triggerStep: mocks.triggerStep,
}));

vi.mock("@/lib/workflow/nodes/for-each/step", () => ({
  forEachStep: mocks.forEachStep,
}));

vi.mock("@/lib/workflow/nodes/http-request/step", () => ({
  httpRequestStep: mocks.httpRequestStep,
}));

vi.mock("@/lib/workflow/nodes/collect/step", () => ({
  collectStep: mocks.collectStep,
}));

vi.mock("@/lib/workflow/executor/get-completed-step-output", () => ({
  clearOutputCache: vi.fn(),
  getCompletedStepOutput: mocks.getCompletedStepOutput,
}));

vi.mock("@/lib/workflow/executor/get-completed-step-output.step", () => ({
  awaitCompletedStepOutputStep: mocks.awaitCompletedStepOutputStep,
  awaitCompletedStepOutputAtIterationStep:
    mocks.awaitCompletedStepOutputAtIterationStep,
}));

import { executeWorkflow } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

const EXECUTION_ID = "exec-for-each-recovery";
const ITEMS = [{ txHash: "0xa" }, { txHash: "0xb" }, { txHash: "0xc" }];

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: { triggerType: "Manual" },
    },
  },
  {
    id: "loop",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Loop",
      type: "action",
      config: { actionType: "For Each", arraySource: JSON.stringify(ITEMS) },
    },
  },
  {
    id: "trace",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Trace",
      type: "action",
      config: {
        actionType: "HTTP Request",
        endpoint: "https://rpc.example/{{@loop:Loop.currentItem.txHash}}",
        httpMethod: "POST",
      },
    },
  },
  {
    id: "collect",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Collect",
      type: "action",
      config: { actionType: "Collect" },
    },
  },
];

const edges: WorkflowEdge[] = [
  { id: "e1", source: "trigger", target: "loop" },
  { id: "e2", source: "loop", target: "trace", sourceHandle: "loop" },
  { id: "e3", source: "trace", target: "collect" },
];

type HttpCall = { iterationIndex: unknown; endpoint: unknown };

function httpCalls(): HttpCall[] {
  return mocks.httpRequestStep.mock.calls.map(([input]) => ({
    iterationIndex: input._context?.iterationIndex,
    endpoint: input.endpoint,
  }));
}

type RunResult = {
  success: boolean;
  results: Record<string, { success: boolean; error?: string }>;
};

const doneCollectEdges: WorkflowEdge[] = [
  { id: "e1", source: "trigger", target: "loop" },
  { id: "e2", source: "loop", target: "trace", sourceHandle: "loop" },
  { id: "e3", source: "loop", target: "collect", sourceHandle: "done" },
];

function run(runEdges: WorkflowEdge[] = edges): Promise<RunResult> {
  return executeWorkflow({
    nodes,
    edges: runEdges,
    triggerInput: {},
    executionId: EXECUTION_ID,
    workflowId: "wf-1",
  }) as Promise<RunResult>;
}

describe("executeWorkflow: For Each spurious max-retries recovery", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.triggerStep.mockImplementation(
      (input: { triggerData?: unknown }) => ({
        success: true,
        data: input.triggerData ?? {},
      })
    );
    mocks.forEachStep.mockResolvedValue({ success: true });
    mocks.httpRequestStep.mockImplementation((input: { endpoint: string }) => ({
      success: true,
      data: { url: input.endpoint },
    }));
    mocks.collectStep.mockResolvedValue({ success: true });
    mocks.getCompletedStepOutput.mockResolvedValue(null);
    mocks.awaitCompletedStepOutputStep.mockResolvedValue(null);
    mocks.awaitCompletedStepOutputAtIterationStep.mockResolvedValue(null);
  });

  it("runs every body step inside the loop when nothing fails", async () => {
    const result = await run();

    expect(result.success).toBe(true);
    expect(httpCalls()).toEqual([
      { iterationIndex: 0, endpoint: "https://rpc.example/0xa" },
      { iterationIndex: 1, endpoint: "https://rpc.example/0xb" },
      { iterationIndex: 2, endpoint: "https://rpc.example/0xc" },
    ]);
  });

  it("succeeds with the Collect on the done handle", async () => {
    const result = await run(doneCollectEdges);

    expect(result.results.collect).toMatchObject({ success: true });
    expect(result.success).toBe(true);
    expect(mocks.collectStep).toHaveBeenCalledOnce();
    expect(httpCalls()).toHaveLength(3);
  });

  it("runs the body inside the loop when the For Each step is recovered", async () => {
    mocks.forEachStep.mockRejectedValue(MAX_RETRIES("forEachStep"));
    mocks.getCompletedStepOutput.mockImplementation(
      (_executionId: string, nodeId: string) =>
        nodeId === "loop"
          ? { output: { success: true, arrayLength: 3 }, source: "db" }
          : null
    );

    const result = await run();

    expect(result.success).toBe(true);
    expect(result.results.loop?.success).toBe(true);
    expect(httpCalls()).toEqual([
      { iterationIndex: 0, endpoint: "https://rpc.example/0xa" },
      { iterationIndex: 1, endpoint: "https://rpc.example/0xb" },
      { iterationIndex: 2, endpoint: "https://rpc.example/0xc" },
    ]);
  });

  it("does not run the loop a second time when the throw comes from inside it", async () => {
    mocks.collectStep.mockRejectedValue(MAX_RETRIES("collectStep"));
    mocks.getCompletedStepOutput.mockImplementation(
      (_executionId: string, nodeId: string) =>
        nodeId === "loop"
          ? { output: { success: true, arrayLength: 3 }, source: "db" }
          : null
    );

    await run();

    expect(mocks.httpRequestStep).toHaveBeenCalledTimes(3);
    expect(mocks.collectStep).toHaveBeenCalledOnce();
    expect(
      httpCalls().every((call) => typeof call.iterationIndex === "number")
    ).toBe(true);
  });

  it("keeps the For Each failed after the run when its Collect threw", async () => {
    mocks.collectStep.mockRejectedValue(MAX_RETRIES("collectStep"));
    mocks.getCompletedStepOutput.mockImplementation(
      (_executionId: string, nodeId: string) =>
        nodeId === "loop"
          ? { output: { success: true, arrayLength: 3 }, source: "db" }
          : null
    );

    const result = await run();

    expect(result.results.loop).toMatchObject({ success: false });
    expect(result.success).toBe(false);
  });

  it("keeps the For Each failed after the run when an iteration was dropped", async () => {
    mocks.httpRequestStep.mockImplementation(
      (input: { endpoint: string; _context?: { iterationIndex?: number } }) => {
        if (input._context?.iterationIndex === 1) {
          return Promise.reject(MAX_RETRIES("httpRequestStep"));
        }
        return { success: true, data: { url: input.endpoint } };
      }
    );
    mocks.getCompletedStepOutput.mockImplementation(
      (_executionId: string, nodeId: string) =>
        nodeId === "loop"
          ? { output: { success: true, arrayLength: 3 }, source: "db" }
          : null
    );

    const result = await run();

    expect(result.results.loop).toMatchObject({ success: false });
    expect(result.success).toBe(false);
    expect(mocks.collectStep).not.toHaveBeenCalled();
  });

  it("recovers a body step whose first attempt was still running", async () => {
    mocks.httpRequestStep.mockImplementation(
      (input: { endpoint: string; _context?: { iterationIndex?: number } }) => {
        if (input._context?.iterationIndex === 0) {
          return Promise.reject(MAX_RETRIES("httpRequestStep"));
        }
        return { success: true, data: { url: input.endpoint } };
      }
    );
    mocks.awaitCompletedStepOutputAtIterationStep.mockResolvedValue({
      outputRaw: { success: true, data: { url: "https://rpc.example/0xa" } },
    });

    const result = await run();

    expect(result.success).toBe(true);
    expect(
      mocks.awaitCompletedStepOutputAtIterationStep
    ).toHaveBeenCalledOnce();
    expect(
      mocks.awaitCompletedStepOutputAtIterationStep.mock.calls[0]?.slice(0, 4)
    ).toEqual([EXECUTION_ID, "trace", "loop", 0]);
    expect(mocks.collectStep).toHaveBeenCalledOnce();
    expect(
      mocks.collectStep.mock.calls[0]?.[0]?.results as unknown[]
    ).toHaveLength(3);
  });
});
