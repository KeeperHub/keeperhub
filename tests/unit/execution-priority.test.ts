import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateWorkflow } from "@/lib/mcp/validate-workflow";
import { VALIDATION_WARNING_CODES } from "@/lib/mcp/validate-workflow-codes";
import {
  executionPriorityWarning,
  getWorkflowExecutionPriority,
  LOW_LATENCY_DISPATCH_TRIGGERS,
  LOW_LATENCY_TRIGGER_TYPES,
  readExecutionPriority,
} from "@/lib/workflow/execution-priority";

function trigger(config: Record<string, unknown> | null): unknown {
  return { id: "trigger-1", data: { type: "trigger", config } };
}

describe("execution priority", () => {
  it("reads only the exact low-latency value as low latency", () => {
    expect(readExecutionPriority("low-latency")).toBe("low-latency");
    for (const value of [undefined, null, "standard", "Low-Latency", true, 1]) {
      expect(readExecutionPriority(value)).toBe("standard");
    }
  });

  it("reads the setting from the trigger node", () => {
    expect(
      getWorkflowExecutionPriority([
        {
          data: {
            type: "action",
            config: { executionPriority: "low-latency" },
          },
        },
        trigger({ triggerType: "Block", executionPriority: "low-latency" }),
      ])
    ).toBe("low-latency");
    expect(getWorkflowExecutionPriority([trigger(null)])).toBe("standard");
    expect(getWorkflowExecutionPriority([])).toBe("standard");
    expect(getWorkflowExecutionPriority([null])).toBe("standard");
  });

  it("offers the setting in the editor for exactly the triggers the executor honours", () => {
    expect(
      LOW_LATENCY_TRIGGER_TYPES.map((t) => t.toLowerCase()).sort()
    ).toEqual([...LOW_LATENCY_DISPATCH_TRIGGERS].sort());
  });

  describe("executionPriorityWarning", () => {
    it("is quiet for no setting, standard, and low latency on a supported trigger", () => {
      expect(
        executionPriorityWarning({ triggerType: "Block" })
      ).toBeUndefined();
      expect(
        executionPriorityWarning({
          triggerType: "Manual",
          executionPriority: "standard",
        })
      ).toBeUndefined();
      for (const triggerType of LOW_LATENCY_TRIGGER_TYPES) {
        expect(
          executionPriorityWarning({
            triggerType,
            executionPriority: "low-latency",
          })
        ).toBeUndefined();
      }
    });

    it("warns about an unknown value", () => {
      expect(
        executionPriorityWarning({
          triggerType: "Block",
          executionPriority: "low_latency",
        })
      ).toContain("is not one of");
    });

    it("warns that low latency does nothing on a manual trigger", () => {
      expect(
        executionPriorityWarning({
          triggerType: "Manual",
          executionPriority: "low-latency",
        })
      ).toContain("has no effect on a Manual trigger");
    });
  });

  it("surfaces the warning from validate_workflow without failing validation", () => {
    const result = validateWorkflow({
      id: "wf-1",
      nodes: [trigger({ triggerType: "Block", executionPriority: "fast" })],
      edges: [],
      inputSchema: null,
      outputMapping: null,
      isListed: false,
      workflowType: "read",
    });
    const warning = result.warnings.find(
      (w) => w.code === VALIDATION_WARNING_CODES.EXECUTION_PRIORITY_IGNORED
    );
    expect(warning?.parameterPath).toBe(
      "nodes[0].data.config.executionPriority"
    );
    expect(
      result.errors.some(
        (e) =>
          (e.code as string) ===
          VALIDATION_WARNING_CODES.EXECUTION_PRIORITY_IGNORED
      )
    ).toBe(false);
  });
});
