import { describe, expect, it } from "vitest";
import { hasTemplateVariables } from "@/lib/utils/template";
import { findActiveAtIndex } from "@/lib/workflow/editor/template-helpers";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";

// The old `[^}]+` patterns took seconds on a run of `{` with no closing brace.
const BRACE_FLOOD = "{".repeat(100_000);
const TIME_LIMIT_MS = 100;

function timed<T>(run: () => T): { result: T; elapsedMs: number } {
  const start = performance.now();
  const result = run();
  return { result, elapsedMs: performance.now() - start };
}

describe("template patterns on a brace flood", () => {
  it("hasTemplateVariables stays fast and still finds real references", () => {
    const { result, elapsedMs } = timed(() =>
      hasTemplateVariables(BRACE_FLOOD)
    );
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(TIME_LIMIT_MS);

    expect(hasTemplateVariables("to {{@n1:Fetch.address}}")).toBe(true);
    expect(hasTemplateVariables("{{{@n1:Fetch.address}}")).toBe(true);
    expect(hasTemplateVariables("{{trigger.amount}}")).toBe(true);
    expect(hasTemplateVariables("{{}}")).toBe(false);
  });

  it("findActiveAtIndex stays fast on a brace flood", () => {
    const { result, elapsedMs } = timed(() =>
      findActiveAtIndex(`${BRACE_FLOOD}@`)
    );
    expect(result).toBe(BRACE_FLOOD.length);
    expect(elapsedMs).toBeLessThan(TIME_LIMIT_MS);
  });

  it("action config validation stays fast and rejects the flood as an address", () => {
    const node = {
      id: "node-1",
      type: "action",
      data: {
        label: "Supply",
        type: "action",
        config: {
          actionType: "aave-v3/supply",
          network: "1",
          asset: BRACE_FLOOD,
          amount: "{{@node-0:Previous.amount}}",
          onBehalfOf: "{{@node-0:Previous.recipient}}",
        },
      },
    };
    const { result, elapsedMs } = timed(() =>
      validateWorkflowActionConfigs([node])
    );
    expect(elapsedMs).toBeLessThan(TIME_LIMIT_MS);
    expect(result.issues.map((issue) => issue.field)).toEqual(["asset"]);
  });
});
