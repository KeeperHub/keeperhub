import { describe, expect, it } from "vitest";
import {
  getTriggerTypeFromConfig,
  WorkflowTriggerEnum,
} from "@/lib/workflow/store";
import {
  countDeactivated,
  countTriggerStatuses,
  describeEmptyFilterResult,
  getTriggerAccessibleStatus,
  getTriggerConfig,
  getTriggerLabel,
  getTriggerStatus,
  getTriggerTooltip,
  getTriggerTypeLabel,
  isSameTriggerDisplay,
  matchesTriggerFilter,
  type TriggerFilter,
  type TriggerStatus,
  toggleTriggerFilter,
} from "@/lib/workflow/trigger-display";

const SWITCHABLE = [
  WorkflowTriggerEnum.SCHEDULE,
  WorkflowTriggerEnum.EVENT,
  WorkflowTriggerEnum.BLOCK,
  WorkflowTriggerEnum.WEBHOOK,
  WorkflowTriggerEnum.TEMPO_PAYMENT,
  WorkflowTriggerEnum.PYTH_PRICE,
];

describe("getTriggerStatus", () => {
  it.each(SWITCHABLE)("is enabled for an enabled %s trigger", (trigger) => {
    expect(getTriggerStatus({ triggerType: trigger, enabled: true })).toBe(
      "enabled"
    );
  });

  it.each(SWITCHABLE)("is disabled for a disabled %s trigger", (trigger) => {
    expect(getTriggerStatus({ triggerType: trigger, enabled: false })).toBe(
      "disabled"
    );
  });

  it("treats a missing enabled flag as disabled", () => {
    expect(
      getTriggerStatus({ triggerType: WorkflowTriggerEnum.SCHEDULE })
    ).toBe("disabled");
  });

  it("is manual for a Manual trigger whatever the enabled flag says", () => {
    expect(
      getTriggerStatus({
        triggerType: WorkflowTriggerEnum.MANUAL,
        enabled: true,
      })
    ).toBe("manual");
    expect(
      getTriggerStatus({
        triggerType: WorkflowTriggerEnum.MANUAL,
        enabled: false,
      })
    ).toBe("manual");
  });

  it("is manual when no trigger is configured yet", () => {
    expect(getTriggerStatus({ enabled: true })).toBe("manual");
  });

  it("is disabled when ops deactivated it, even if enabled or manual", () => {
    const deactivatedAt = "2026-10-01T00:00:00.000Z";
    expect(
      getTriggerStatus({
        triggerType: WorkflowTriggerEnum.SCHEDULE,
        enabled: true,
        deactivatedAt,
      })
    ).toBe("disabled");
    expect(
      getTriggerStatus({
        triggerType: WorkflowTriggerEnum.MANUAL,
        deactivatedAt,
      })
    ).toBe("disabled");
  });
});

describe("getTriggerLabel", () => {
  const enabledSchedule = (
    triggerConfig: Record<string, unknown>
  ): Parameters<typeof getTriggerLabel>[0] => ({
    triggerType: WorkflowTriggerEnum.SCHEDULE,
    enabled: true,
    triggerConfig,
  });

  it.each([
    ["*/5 * * * *", "5 min"],
    ["*/15 * * * *", "15 min"],
    ["* * * * *", "1 min"],
    ["0 * * * *", "Hourly"],
    ["30 * * * *", "Hourly"],
    ["0 */6 * * *", "6 h"],
    ["0 */1 * * *", "Hourly"],
    ["0 9 * * *", "Daily"],
    ["0 9 * * 1", "Weekly"],
    ["0 9 * * 1-5", "Weekdays"],
    ["0 9 * * 1,3,5", "3x a week"],
    ["0 9 * * 0,7", "Schedule"],
    ["0 */0 * * *", "Schedule"],
    ["*/7 * * * *", "7 min"],
    ["0 9 1 * *", "Custom"],
    ["0 0 9 * * *", "Custom"],
    ["not a cron", "Schedule"],
  ])("labels cron %s as %s", (scheduleCron, label) => {
    expect(getTriggerLabel(enabledSchedule({ scheduleCron }))).toBe(label);
  });

  it.each([
    [300, "5 min"],
    ["900", "15 min"],
    [3600, "Hourly"],
    [7200, "2 h"],
    [5400, "90 min"],
    [90, "90 s"],
    [1830, "1830 s"],
    [86_400, "Daily"],
    [604_800, "Weekly"],
    [172_800, "2 d"],
  ])("labels interval %s seconds as %s", (scheduleIntervalSeconds, label) => {
    expect(getTriggerLabel(enabledSchedule({ scheduleIntervalSeconds }))).toBe(
      label
    );
  });

  it("prefers the interval over a stale cron", () => {
    expect(
      getTriggerLabel(
        enabledSchedule({
          scheduleIntervalSeconds: 600,
          scheduleCron: "0 * * * *",
        })
      )
    ).toBe("10 min");
  });

  it("falls back to Schedule for a sub-minute or empty schedule", () => {
    expect(
      getTriggerLabel(enabledSchedule({ scheduleIntervalSeconds: 30 }))
    ).toBe("Schedule");
    expect(getTriggerLabel(enabledSchedule({}))).toBe("Schedule");
  });

  it("names the event for an Event trigger", () => {
    expect(
      getTriggerLabel({
        triggerType: WorkflowTriggerEnum.EVENT,
        enabled: true,
        triggerConfig: { eventName: "Lift" },
      })
    ).toBe("Lift");
    expect(
      getTriggerLabel({ triggerType: WorkflowTriggerEnum.EVENT, enabled: true })
    ).toBe("Event");
  });

  it("gives the block interval for a Block trigger", () => {
    const block = (blockInterval: unknown): string =>
      getTriggerLabel({
        triggerType: WorkflowTriggerEnum.BLOCK,
        enabled: true,
        triggerConfig: { blockInterval },
      });
    expect(block("10")).toBe("Every 10 blocks");
    expect(block(1)).toBe("Every block");
    expect(block("")).toBe("Block");
  });

  it.each([
    [WorkflowTriggerEnum.WEBHOOK, "Webhook"],
    [WorkflowTriggerEnum.TEMPO_PAYMENT, "Transfer"],
    [WorkflowTriggerEnum.PYTH_PRICE, "Pyth Price"],
  ])("uses the trigger name for %s", (triggerType, label) => {
    expect(getTriggerLabel({ triggerType, enabled: true })).toBe(label);
  });

  it("says Disabled instead of the cadence when the workflow is off", () => {
    expect(
      getTriggerLabel({
        triggerType: WorkflowTriggerEnum.SCHEDULE,
        enabled: false,
        triggerConfig: { scheduleCron: "*/5 * * * *" },
      })
    ).toBe("Disabled");
  });

  it("says Manual for a manual workflow, never Disabled", () => {
    expect(
      getTriggerLabel({
        triggerType: WorkflowTriggerEnum.MANUAL,
        enabled: false,
      })
    ).toBe("Manual");
  });

  it("says Deactivated for a deactivated manual workflow too", () => {
    expect(
      getTriggerLabel({
        triggerType: WorkflowTriggerEnum.MANUAL,
        deactivatedAt: "2026-10-01T00:00:00.000Z",
      })
    ).toBe("Deactivated");
  });

  it("says Deactivated when ops deactivated it", () => {
    expect(
      getTriggerLabel({
        triggerType: WorkflowTriggerEnum.SCHEDULE,
        enabled: true,
        deactivatedAt: "2026-10-01T00:00:00.000Z",
      })
    ).toBe("Deactivated");
  });
});

describe("getTriggerConfig", () => {
  it("returns the trigger node's config", () => {
    const config = { triggerType: "Schedule", scheduleCron: "*/5 * * * *" };
    expect(
      getTriggerConfig([
        { data: { type: "action", config: { actionType: "x" } } },
        { data: { type: "trigger", config } },
      ])
    ).toBe(config);
  });

  it("returns undefined without a trigger node", () => {
    expect(getTriggerConfig([])).toBeUndefined();
  });

  it("returns the same empty config for a trigger node without one", () => {
    const first = getTriggerConfig([{ data: { type: "trigger" } }]);
    expect(first).toEqual({});
    expect(getTriggerConfig([{ data: { type: "trigger" } }])).toBe(first);
  });
});

describe("countTriggerStatuses and matchesTriggerFilter", () => {
  const workflows = [
    { triggerType: WorkflowTriggerEnum.SCHEDULE, enabled: true },
    { triggerType: WorkflowTriggerEnum.EVENT, enabled: true },
    { triggerType: WorkflowTriggerEnum.BLOCK, enabled: false },
    { triggerType: WorkflowTriggerEnum.MANUAL, enabled: false },
  ];

  it("counts each status", () => {
    expect(countTriggerStatuses(workflows)).toEqual({
      all: 4,
      enabled: 2,
      disabled: 1,
      manual: 1,
    });
  });

  const pick = (...statuses: TriggerStatus[]): typeof workflows =>
    workflows.filter((w) => matchesTriggerFilter(w, new Set(statuses)));

  it("keeps everything when nothing is picked", () => {
    expect(pick()).toHaveLength(4);
  });

  it("keeps only the picked status", () => {
    expect(pick("enabled")).toHaveLength(2);
    expect(pick("manual")).toEqual([workflows[3]]);
  });

  it("combines several picked statuses", () => {
    expect(pick("enabled", "disabled")).toEqual(workflows.slice(0, 3));
    expect(pick("disabled", "manual")).toEqual(workflows.slice(2));
  });
});

describe("toggleTriggerFilter", () => {
  it("adds a status that is not picked and removes one that is", () => {
    const one = toggleTriggerFilter(new Set(), "enabled");
    expect([...one]).toEqual(["enabled"]);
    const two = toggleTriggerFilter(one, "disabled");
    expect([...two].sort()).toEqual(["disabled", "enabled"]);
    expect([...toggleTriggerFilter(two, "enabled")]).toEqual(["disabled"]);
  });

  it("turns back into All when every status is picked", () => {
    const two: TriggerFilter = new Set(["enabled", "disabled"]);
    expect([...toggleTriggerFilter(two, "manual")]).toEqual([]);
  });

  it("does not change the filter it was given", () => {
    const original: TriggerFilter = new Set(["manual"]);
    toggleTriggerFilter(original, "manual");
    expect([...original]).toEqual(["manual"]);
  });
});

describe("getTriggerTypeLabel", () => {
  it.each([
    [WorkflowTriggerEnum.BLOCK, "Block trigger"],
    [WorkflowTriggerEnum.TEMPO_PAYMENT, "Transfer trigger"],
    [WorkflowTriggerEnum.SCHEDULE, "Schedule trigger"],
    [undefined, "Manual trigger"],
  ])("names %s as %s", (triggerType, label) => {
    expect(getTriggerTypeLabel(triggerType)).toBe(label);
  });
});

describe("getTriggerAccessibleStatus", () => {
  it("leads with the status, then the trigger", () => {
    expect(
      getTriggerAccessibleStatus({
        triggerType: WorkflowTriggerEnum.SCHEDULE,
        enabled: true,
      })
    ).toBe("Enabled, Schedule trigger");
    expect(
      getTriggerAccessibleStatus({
        triggerType: WorkflowTriggerEnum.EVENT,
        enabled: false,
      })
    ).toBe("Disabled, Event trigger");
  });

  it("names a manual trigger without calling it disabled", () => {
    expect(
      getTriggerAccessibleStatus({
        triggerType: WorkflowTriggerEnum.MANUAL,
        enabled: false,
      })
    ).toBe("Manual trigger");
  });

  it("includes the schedule in full, with commas only", () => {
    expect(
      getTriggerAccessibleStatus({
        triggerType: WorkflowTriggerEnum.SCHEDULE,
        enabled: true,
        triggerConfig: { scheduleCron: "*/5 * * * *" },
      })
    ).toBe("Enabled, Schedule trigger, Every 5 minutes");
  });

  it("never says undefined for a deactivated workflow with no trigger", () => {
    expect(
      getTriggerAccessibleStatus({ deactivatedAt: "2026-10-01T00:00:00.000Z" })
    ).toBe(
      "Deactivated, Manual trigger. Turned off by KeeperHub. Contact support to turn it back on."
    );
  });
});

describe("isSameTriggerDisplay", () => {
  const base = {
    triggerType: "Schedule",
    scheduleCron: "*/5 * * * *",
    contractABI: "[]",
  };

  it("ignores fields the row does not show", () => {
    expect(isSameTriggerDisplay(base, { ...base, contractABI: "[{}]" })).toBe(
      true
    );
  });

  it("notices a change to a field the row shows", () => {
    expect(
      isSameTriggerDisplay(base, { ...base, scheduleCron: "0 * * * *" })
    ).toBe(false);
    expect(isSameTriggerDisplay(base, { ...base, triggerType: "Manual" })).toBe(
      false
    );
  });

  it("treats a trigger node appearing or going away as a change", () => {
    expect(isSameTriggerDisplay(undefined, base)).toBe(false);
    expect(isSameTriggerDisplay(base, undefined)).toBe(false);
    expect(isSameTriggerDisplay(undefined, undefined)).toBe(true);
  });
});

describe("trigger type read off a node list", () => {
  const readType = (
    nodes: Parameters<typeof getTriggerConfig>[0]
  ): ReturnType<typeof getTriggerTypeFromConfig> =>
    getTriggerTypeFromConfig(getTriggerConfig(nodes));

  it("returns the trigger node's type", () => {
    expect(
      readType([
        { data: { type: "trigger", config: { triggerType: "Schedule" } } },
        { data: { type: "action", config: { actionType: "webhook/send" } } },
      ])
    ).toBe(WorkflowTriggerEnum.SCHEDULE);
  });

  it("returns undefined without a trigger node or a trigger type", () => {
    expect(readType([])).toBeUndefined();
    expect(readType([{ data: { type: "trigger" } }])).toBeUndefined();
  });

  it("normalizes the legacy Scheduled spelling", () => {
    expect(
      readType([
        { data: { type: "trigger", config: { triggerType: "Scheduled" } } },
      ])
    ).toBe(WorkflowTriggerEnum.SCHEDULE);
  });
});

describe("getTriggerTooltip", () => {
  const schedule = (
    triggerConfig: Record<string, unknown>
  ): Parameters<typeof getTriggerTooltip>[0] => ({
    triggerType: WorkflowTriggerEnum.SCHEDULE,
    triggerConfig,
  });

  it.each([
    [{ scheduleCron: "*/5 * * * *" }, "Schedule trigger · Every 5 minutes"],
    [{ scheduleCron: "0 */6 * * *" }, "Schedule trigger · Every 6 hours"],
    [{ scheduleIntervalSeconds: 900 }, "Schedule trigger · Every 15 minutes"],
    [{ scheduleIntervalSeconds: 3600 }, "Schedule trigger · Every hour"],
    [{ scheduleIntervalSeconds: 86_400 }, "Schedule trigger · Every day"],
    [{ scheduleCron: "0 */1 * * *" }, "Schedule trigger · Every hour"],
    [{ scheduleIntervalSeconds: 90 }, "Schedule trigger · Every 90 seconds"],
    [{ scheduleCron: "0 9 1 * *" }, "Schedule trigger · Cron 0 9 1 * *"],
    [{}, "Schedule trigger"],
  ])("spells out the schedule %o", (config, tooltip) => {
    expect(getTriggerTooltip(schedule(config))).toBe(tooltip);
  });

  it("adds the timezone to a schedule at a set time", () => {
    expect(
      getTriggerTooltip(
        schedule({ scheduleCron: "0 9 * * *", scheduleTimezone: "UTC" })
      )
    ).toBe("Schedule trigger · Every day at 9:00 AM (UTC)");
  });

  it("names the event and the block interval", () => {
    expect(
      getTriggerTooltip({
        triggerType: WorkflowTriggerEnum.EVENT,
        triggerConfig: { eventName: "Lift" },
      })
    ).toBe("Event trigger · Lift");
    expect(
      getTriggerTooltip({
        triggerType: WorkflowTriggerEnum.BLOCK,
        triggerConfig: { blockInterval: "10" },
      })
    ).toBe("Block trigger · Every 10 blocks");
    expect(
      getTriggerTooltip({
        triggerType: WorkflowTriggerEnum.BLOCK,
        triggerConfig: { blockInterval: 1 },
      })
    ).toBe("Block trigger · Every block");
  });

  it("is just the type when there is nothing to add", () => {
    expect(getTriggerTooltip({ triggerType: WorkflowTriggerEnum.EVENT })).toBe(
      "Event trigger"
    );
    expect(
      getTriggerTooltip({ triggerType: WorkflowTriggerEnum.WEBHOOK })
    ).toBe("Webhook trigger");
    expect(getTriggerTooltip({})).toBe("Manual trigger");
  });
});

describe("describeEmptyFilterResult", () => {
  it.each([
    [[], "lift", "No workflows match \u201clift\u201d"],
    [["disabled"], "lift", "No disabled workflows match \u201clift\u201d"],
    [["disabled"], "", "No disabled workflows"],
    [["manual", "enabled"], "", "No enabled or manual workflows"],
    [["enabled"], "  hat  ", "No enabled workflows match \u201chat\u201d"],
  ] as const)("filter %j with query %j says %s", (statuses, query, text) => {
    expect(describeEmptyFilterResult(new Set(statuses), query)).toBe(text);
  });
});

describe("countDeactivated", () => {
  it("counts only workflows ops switched off", () => {
    expect(
      countDeactivated([
        { deactivatedAt: "2026-10-01T00:00:00.000Z" },
        { deactivatedAt: null },
        {},
      ])
    ).toBe(1);
  });
});
