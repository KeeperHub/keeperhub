import { describe, expect, it } from "vitest";
import {
  getWorkflowTriggerType,
  shouldShowDisabledBadge,
  shouldShowEnableSwitch,
  WorkflowTriggerEnum,
} from "@/lib/workflow/store";

describe("shouldShowEnableSwitch", () => {
  it.each([
    WorkflowTriggerEnum.EVENT,
    WorkflowTriggerEnum.SCHEDULE,
    WorkflowTriggerEnum.BLOCK,
    WorkflowTriggerEnum.WEBHOOK,
  ])("returns true for %s triggers (server gates on workflows.enabled)", (trigger) => {
    expect(shouldShowEnableSwitch(trigger)).toBe(true);
  });

  it("returns false for Manual triggers (no scheduled invocation to disable)", () => {
    expect(shouldShowEnableSwitch(WorkflowTriggerEnum.MANUAL)).toBe(false);
  });

  it("returns false when no trigger is configured yet", () => {
    expect(shouldShowEnableSwitch(undefined)).toBe(false);
  });
});

describe("getWorkflowTriggerType", () => {
  it("returns the triggerType from the trigger node when present", () => {
    const nodes = [
      {
        data: {
          type: "trigger",
          config: { triggerType: WorkflowTriggerEnum.SCHEDULE },
        },
      },
      { data: { type: "action", config: { actionType: "webhook/send" } } },
    ];
    expect(getWorkflowTriggerType(nodes)).toBe(WorkflowTriggerEnum.SCHEDULE);
  });

  it("returns undefined when there is no trigger node", () => {
    const nodes = [
      { data: { type: "action", config: { actionType: "webhook/send" } } },
    ];
    expect(getWorkflowTriggerType(nodes)).toBeUndefined();
  });

  it("returns undefined when the trigger node has no config.triggerType", () => {
    const nodes = [{ data: { type: "trigger" } }];
    expect(getWorkflowTriggerType(nodes)).toBeUndefined();
  });

  it("returns undefined for an empty node list", () => {
    expect(getWorkflowTriggerType([])).toBeUndefined();
  });

  it("normalizes the legacy 'Scheduled' spelling to 'Schedule'", () => {
    // Older workflow rows persist `triggerType: "Scheduled"`; executor,
    // metrics, and mcp call sites all canonicalize the same way before
    // comparing, so the picker has to as well or it misses the badge.
    const nodes = [
      {
        data: { type: "trigger", config: { triggerType: "Scheduled" } },
      },
    ];
    expect(getWorkflowTriggerType(nodes)).toBe(WorkflowTriggerEnum.SCHEDULE);
  });
});

describe("shouldShowDisabledBadge", () => {
  it("returns false when enabled is true (workflow is on)", () => {
    expect(
      shouldShowDisabledBadge({
        enabled: true,
        triggerType: WorkflowTriggerEnum.SCHEDULE,
      })
    ).toBe(false);
  });

  it("returns true for a disabled schedulable workflow", () => {
    expect(
      shouldShowDisabledBadge({
        enabled: false,
        triggerType: WorkflowTriggerEnum.SCHEDULE,
      })
    ).toBe(true);
  });

  it.each([
    WorkflowTriggerEnum.EVENT,
    WorkflowTriggerEnum.SCHEDULE,
    WorkflowTriggerEnum.BLOCK,
    WorkflowTriggerEnum.WEBHOOK,
  ])("returns true for %s triggers when enabled = false", (trigger) => {
    expect(
      shouldShowDisabledBadge({ enabled: false, triggerType: trigger })
    ).toBe(true);
  });

  it("returns false for Manual triggers regardless of enabled flag", () => {
    // Manual workflows default to enabled = false in the DB but have no UI
    // toggle, so labeling them "Disabled" would be misleading noise.
    expect(
      shouldShowDisabledBadge({
        enabled: false,
        triggerType: WorkflowTriggerEnum.MANUAL,
      })
    ).toBe(false);
  });

  it("returns false when triggerType is undefined (workflow has no trigger yet)", () => {
    expect(shouldShowDisabledBadge({ enabled: false })).toBe(false);
  });

  it("returns false when enabled is undefined", () => {
    expect(
      shouldShowDisabledBadge({ triggerType: WorkflowTriggerEnum.SCHEDULE })
    ).toBe(false);
  });
});
