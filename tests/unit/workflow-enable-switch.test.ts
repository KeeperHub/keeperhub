import { describe, expect, it } from "vitest";
import {
  shouldShowEnableSwitch,
  WorkflowTriggerEnum,
} from "@/lib/workflow/store";

describe("shouldShowEnableSwitch", () => {
  it.each([
    WorkflowTriggerEnum.EVENT,
    WorkflowTriggerEnum.SCHEDULE,
    WorkflowTriggerEnum.BLOCK,
    WorkflowTriggerEnum.WEBHOOK,
  ])(
    "returns true for %s triggers (server gates on workflows.enabled)",
    (trigger) => {
      expect(shouldShowEnableSwitch(trigger)).toBe(true);
    }
  );

  it("returns false for Manual triggers (no scheduled invocation to disable)", () => {
    expect(shouldShowEnableSwitch(WorkflowTriggerEnum.MANUAL)).toBe(false);
  });

  it("returns false when no trigger is configured yet", () => {
    expect(shouldShowEnableSwitch(undefined)).toBe(false);
  });
});
