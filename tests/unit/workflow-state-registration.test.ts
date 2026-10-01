import { describe, expect, it } from "vitest";
import { resolveActionFeature } from "@/lib/features/action-egress";
import { getFeatureForActionType } from "@/lib/features/registry";
import { getSystemActionEgress } from "@/lib/features/system-action-capabilities";
import { SYSTEM_ACTIONS } from "@/lib/mcp/workflow-schema-constants";
import { SYSTEM_ACTION_TYPES } from "@/lib/workflow/executor/system-action-types";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";

const WORKFLOW_STATE_ACTIONS = ["State Get", "State Set"] as const;

describe("workflow-state action registration", () => {
  it.each(WORKFLOW_STATE_ACTIONS)(
    "%s is a registered system action in the shared union and the schema catalog",
    (actionType) => {
      expect(SYSTEM_ACTION_TYPES).toContain(actionType);
      expect(SYSTEM_ACTIONS).toHaveProperty(actionType);
    }
  );

  it.each(WORKFLOW_STATE_ACTIONS)(
    "%s carries no network egress (internal in-process action)",
    (actionType) => {
      expect(getSystemActionEgress(actionType)).toBe("none");
    }
  );

  it.each(WORKFLOW_STATE_ACTIONS)(
    "%s is not plan-gated, so a free-plan workflow may use it",
    (actionType) => {
      // No explicit feature, and egress is not user-destination, so neither
      // the direct feature map nor the external-request catch-all gates it.
      // A per-workflow cursor store is infrastructure, not a pro upsell.
      expect(getFeatureForActionType(actionType)).toBeUndefined();
      expect(resolveActionFeature(actionType)).toBeUndefined();
    }
  );
});

describe("validateWorkflowActionConfigs with a workflow-state node", () => {
  it("accepts a State Get action node (not an unknown action type)", () => {
    const result = validateWorkflowActionConfigs([
      {
        id: "state-get-1",
        type: "action",
        data: {
          type: "action",
          label: "State Get",
          config: { actionType: "State Get", key: "lastScannedBlock" },
        },
      },
    ]);

    expect(result.valid).toBe(true);
    expect(
      result.issues.some((issue) => issue.code === "UNKNOWN_ACTION_TYPE")
    ).toBe(false);
  });

  it("accepts a State Set action node", () => {
    const result = validateWorkflowActionConfigs([
      {
        id: "state-set-1",
        type: "action",
        data: {
          type: "action",
          label: "State Set",
          config: {
            actionType: "State Set",
            key: "lastScannedBlock",
            value: 123,
          },
        },
      },
    ]);

    expect(result.valid).toBe(true);
  });
});
