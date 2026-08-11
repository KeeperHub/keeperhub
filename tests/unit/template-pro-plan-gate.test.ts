import { describe, expect, it } from "vitest";
import { workflowRequiredPlan } from "@/lib/features/template-plan-gate";

describe("workflowRequiredPlan", () => {
  it("returns null for trigger + ungated actions only", () => {
    const nodes = [
      { id: "t1", data: { config: { triggerType: "Manual" } } },
      { id: "n1", data: { config: { actionType: "Condition" } } },
    ];
    expect(workflowRequiredPlan(nodes)).toBeNull();
  });

  it("returns pro for webhook/send-webhook", () => {
    const nodes = [
      { id: "n1", data: { config: { actionType: "webhook/send-webhook" } } },
    ];
    expect(workflowRequiredPlan(nodes)).toBe("pro");
  });

  it("returns pro for Database Query", () => {
    const nodes = [
      { id: "n1", data: { config: { actionType: "Database Query" } } },
    ];
    expect(workflowRequiredPlan(nodes)).toBe("pro");
  });

  it("returns null for empty or malformed nodes", () => {
    expect(workflowRequiredPlan([])).toBeNull();
    expect(workflowRequiredPlan([null, 42, "bad"])).toBeNull();
    expect(
      workflowRequiredPlan([{ id: "n1", data: { config: {} } }])
    ).toBeNull();
    expect(
      workflowRequiredPlan({} as unknown as readonly unknown[])
    ).toBeNull();
    expect(
      workflowRequiredPlan(null as unknown as readonly unknown[])
    ).toBeNull();
  });

  it("returns pro for legacy colon actionType on Pro-gated code action", () => {
    const nodes = [{ id: "n1", data: { actionType: "code:run-code" } }];
    expect(workflowRequiredPlan(nodes)).toBe("pro");
  });

  it("returns pro for top-level data.actionType without config", () => {
    const nodes = [{ id: "n1", data: { actionType: "code/run-code" } }];
    expect(workflowRequiredPlan(nodes)).toBe("pro");
  });
});
