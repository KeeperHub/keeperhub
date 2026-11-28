import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  triggerStep: vi.fn(),
  writeContractStep: vi.fn(),
}));

// Only Write Contract resolves, to a stub that records the config it is handed.
vi.mock("@/lib/step-registry", () => ({
  getStepImporter: (actionType: string) =>
    actionType === "web3/write-contract"
      ? {
          importer: () =>
            Promise.resolve({ writeContractStep: mocks.writeContractStep }),
          stepFunction: "writeContractStep",
        }
      : undefined,
  getActionLabel: () => undefined,
}));

vi.mock("@/lib/workflow/nodes/trigger/step", () => ({
  triggerStep: mocks.triggerStep,
}));

import { executeWorkflow } from "@/lib/workflow/executor/executor.workflow";
import type { WorkflowNode } from "@/lib/workflow/store";

function nodes(notBefore: string): WorkflowNode[] {
  return [
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
      id: "write",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Kick",
        type: "action",
        config: {
          actionType: "web3/write-contract",
          sendMode: "bundle",
          notBefore,
        },
      },
    },
  ];
}

async function stepInput(notBefore: string): Promise<Record<string, unknown>> {
  await executeWorkflow({
    nodes: nodes(notBefore),
    edges: [{ id: "e1", source: "trigger", target: "write" }],
    triggerInput: { unlock: null },
    executionId: `exec-not-before-${notBefore.length}`,
    workflowId: "wf-1",
  });
  expect(mocks.writeContractStep).toHaveBeenCalledOnce();
  return mocks.writeContractStep.mock.calls[0][0];
}

describe("executeWorkflow: a Write Contract whose Not before is a template", () => {
  beforeEach(() => {
    mocks.triggerStep.mockReset();
    mocks.writeContractStep.mockReset();
    mocks.triggerStep.mockImplementation(
      (input: { triggerData?: unknown }) => ({
        success: true,
        data: input.triggerData ?? {},
      })
    );
    mocks.writeContractStep.mockResolvedValue({ success: true });
  });

  it("hands the step the mark, so a value that renders empty fails it", async () => {
    const input = await stepInput("{{@trigger:Trigger.unlock}}");
    expect(input.notBefore).toBe("");
    expect(input._notBeforeFromTemplate).toBe(true);
  });

  it("adds no mark for a typed Not before", async () => {
    const input = await stepInput("1796126400");
    expect(input.notBefore).toBe("1796126400");
    expect(input).not.toHaveProperty("_notBeforeFromTemplate");
  });
});
