import { describe, expect, it } from "vitest";
import { resolveActionFeature } from "@/lib/features/action-egress";
import { getFeatureForActionType } from "@/lib/features/registry";
import { getSystemActionEgress } from "@/lib/features/system-action-capabilities";
import { SYSTEM_ACTIONS } from "@/lib/mcp/workflow-schema-constants";
import { SYSTEM_ACTION_TYPES } from "@/lib/workflow/executor/system-action-types";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";

const CIRCUIT_BREAKER_ACTIONS = [
  "Trip Circuit Breaker",
  "Reset Circuit Breaker",
] as const;

describe("circuit-breaker action registration", () => {
  it.each(CIRCUIT_BREAKER_ACTIONS)(
    "%s is a registered system action in the shared union and the schema catalog",
    (actionType) => {
      expect(SYSTEM_ACTION_TYPES).toContain(actionType);
      expect(SYSTEM_ACTIONS).toHaveProperty(actionType);
    }
  );

  it.each(CIRCUIT_BREAKER_ACTIONS)(
    "%s carries no network egress (internal in-process action)",
    (actionType) => {
      expect(getSystemActionEgress(actionType)).toBe("none");
    }
  );

  it.each(CIRCUIT_BREAKER_ACTIONS)(
    "%s is not plan-gated, so a free-plan workflow may use it",
    (actionType) => {
      // No explicit feature, and egress is not user-destination, so neither the
      // direct feature map nor the external-request catch-all gates it.
      expect(getFeatureForActionType(actionType)).toBeUndefined();
      expect(resolveActionFeature(actionType)).toBeUndefined();
    }
  );
});

describe("validateWorkflowActionConfigs with a circuit-breaker node", () => {
  it("accepts a Trip Circuit Breaker action node (not an unknown action type)", () => {
    const result = validateWorkflowActionConfigs([
      {
        id: "trip-1",
        type: "action",
        data: {
          type: "action",
          label: "Trip Circuit Breaker",
          config: { actionType: "Trip Circuit Breaker", reason: "incident" },
        },
      },
    ]);

    expect(result.valid).toBe(true);
    expect(
      result.issues.some((issue) => issue.code === "UNKNOWN_ACTION_TYPE")
    ).toBe(false);
  });

  it("accepts a Reset Circuit Breaker action node", () => {
    const result = validateWorkflowActionConfigs([
      {
        id: "reset-1",
        type: "action",
        data: {
          type: "action",
          label: "Reset Circuit Breaker",
          config: { actionType: "Reset Circuit Breaker" },
        },
      },
    ]);

    expect(result.valid).toBe(true);
  });
});
