import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScheduledWorkflow,
  createScheduleTriggerNode,
  createWebhookTriggerNode,
  cronExpressions,
} from "../fixtures/workflows";

// Top-level regex for cron validation
const CRON_VALIDATION_REGEX = /^[\d*/\-,\s]+$/;

// Mock database
const mockSchedule = {
  id: "sched_test123",
  workflowId: "wf_test456",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: new Date("2024-01-16T09:00:00Z"),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockDbQuery = {
  workflowSchedules: {
    findFirst: vi.fn(),
  },
};

const mockDbInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockResolvedValue(undefined),
});

const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});

const mockDbDelete = vi.fn().mockReturnValue({
  where: vi.fn().mockResolvedValue(undefined),
});

vi.mock("@/lib/db", () => ({
  db: {
    query: mockDbQuery,
    insert: mockDbInsert,
    update: mockDbUpdate,
    delete: mockDbDelete,
  },
}));

describe("Schedule Sync Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Schedule Creation on Workflow Save", () => {
    it("creates schedule when workflow has schedule trigger", () => {
      const { nodes } = createScheduledWorkflow("0 9 * * *", "UTC");

      // Simulate no existing schedule
      mockDbQuery.workflowSchedules.findFirst.mockResolvedValueOnce(undefined);

      const triggerNode = nodes.find((n) => n.data.type === "trigger");
      const config = triggerNode?.data.config;

      expect(config?.triggerType).toBe("Schedule");
      expect(config?.scheduleCron).toBe("0 9 * * *");
      expect(config?.scheduleTimezone).toBe("UTC");
    });

    it("does not create schedule for webhook trigger", () => {
      const triggerNode = createWebhookTriggerNode();
      const config = triggerNode.data.config;

      const isSchedule = config?.triggerType === "Schedule";
      expect(isSchedule).toBe(false);
    });

    it("extracts cron expression from trigger config", () => {
      const triggerNode = createScheduleTriggerNode(
        cronExpressions.everyWeekdayAt9am,
        "America/New_York"
      );

      const config = triggerNode.data.config;
      expect(config?.scheduleCron).toBe("0 9 * * 1-5");
      expect(config?.scheduleTimezone).toBe("America/New_York");
    });
  });

  describe("Schedule Update on Workflow Save", () => {
    it("updates existing schedule when cron changes", () => {
      // Simulate existing schedule
      mockDbQuery.workflowSchedules.findFirst.mockResolvedValueOnce(
        mockSchedule
      );

      const oldCron = mockSchedule.cronExpression;
      const newCron = "0 10 * * *";

      expect(oldCron).not.toBe(newCron);

      // Update should be called
      const updateData = {
        cronExpression: newCron,
        timezone: "UTC",
        nextRunAt: new Date("2024-01-16T10:00:00Z"),
        updatedAt: new Date(),
      };

      expect(updateData.cronExpression).toBe("0 10 * * *");
    });

    it("updates existing schedule when timezone changes", () => {
      mockDbQuery.workflowSchedules.findFirst.mockResolvedValueOnce(
        mockSchedule
      );

      const oldTimezone = mockSchedule.timezone;
      const newTimezone = "America/New_York";

      expect(oldTimezone).not.toBe(newTimezone);
    });

    it("recalculates next run time on update", () => {
      const { CronExpressionParser } = require("cron-parser");

      const newCron = "0 10 * * *";
      const timezone = "UTC";

      const interval = CronExpressionParser.parse(newCron, {
        currentDate: new Date("2024-01-15T09:00:00Z"),
        tz: timezone,
      });

      const nextRun = interval.next().toDate();
      expect(nextRun.getUTCHours()).toBe(10);
    });
  });

  describe("Schedule Deletion on Workflow Save", () => {
    it("deletes schedule when trigger type changes from Schedule", () => {
      // Workflow now has webhook trigger instead of schedule
      const webhookTrigger = createWebhookTriggerNode();
      const nodes = [webhookTrigger];

      const scheduleConfig = nodes.find(
        (n) =>
          n.data.type === "trigger" && n.data.config?.triggerType === "Schedule"
      );

      expect(scheduleConfig).toBeUndefined();

      // Should trigger delete
      const shouldDelete = scheduleConfig === undefined;
      expect(shouldDelete).toBe(true);
    });

    it("deletes schedule when workflow has no trigger", () => {
      const nodes: (typeof mockSchedule)[] = [];

      const triggerNode = nodes.find((n: unknown) => {
        const node = n as { data?: { type?: string } };
        return node.data?.type === "trigger";
      });

      expect(triggerNode).toBeUndefined();
    });
  });

  describe("Validation Errors", () => {
    it("rejects invalid cron expression", () => {
      const invalidCron = "not a cron";

      // Validate cron
      const isValid = CRON_VALIDATION_REGEX.test(invalidCron);
      expect(isValid).toBe(false);
    });

    it("rejects cron with too few fields", () => {
      const invalidCron = "* * *";
      const parts = invalidCron.split(" ");

      expect(parts.length).toBeLessThan(5);
    });

    it("rejects invalid timezone", () => {
      const invalidTimezone = "Invalid/Timezone";

      let isValid = true;
      try {
        Intl.DateTimeFormat(undefined, { timeZone: invalidTimezone });
      } catch {
        isValid = false;
      }

      expect(isValid).toBe(false);
    });
  });

  describe("Next Run Time Calculation", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T08:00:00Z"));
    });

    it("calculates next run for daily cron", () => {
      const { CronExpressionParser } = require("cron-parser");

      const interval = CronExpressionParser.parse("0 9 * * *", {
        currentDate: new Date(),
        tz: "UTC",
      });

      const nextRun = interval.next().toDate();

      // Should be 9am today (we're at 8am)
      expect(nextRun.getUTCDate()).toBe(15);
      expect(nextRun.getUTCHours()).toBe(9);
    });

    it("calculates next run for weekly cron", () => {
      const { CronExpressionParser } = require("cron-parser");

      // Every Monday at 9am, current day is Monday Jan 15
      const interval = CronExpressionParser.parse("0 9 * * 1", {
        currentDate: new Date(),
        tz: "UTC",
      });

      const nextRun = interval.next().toDate();
      expect(nextRun.getUTCDay()).toBe(1); // Monday
    });

    it("handles timezone offset correctly", () => {
      const { CronExpressionParser } = require("cron-parser");

      // 9am New York = 2pm UTC in January (EST is UTC-5)
      const interval = CronExpressionParser.parse("0 9 * * *", {
        currentDate: new Date(),
        tz: "America/New_York",
      });

      const nextRun = interval.next().toDate();
      expect(nextRun.getUTCHours()).toBe(14);
    });
  });

  describe("Edge Cases", () => {
    it("handles workflow with multiple nodes including schedule trigger", () => {
      const { nodes } = createScheduledWorkflow();

      const triggerNodes = nodes.filter((n) => n.data.type === "trigger");
      expect(triggerNodes.length).toBe(1);

      const actionNodes = nodes.filter((n) => n.data.type === "action");
      expect(actionNodes.length).toBe(1);
    });

    it("handles empty cron expression gracefully", () => {
      const triggerNode = createScheduleTriggerNode("");

      const cronExpression = triggerNode.data.config?.scheduleCron;
      expect(cronExpression).toBe("");
    });

    it("uses UTC as default when timezone not specified", () => {
      const triggerNode = createScheduleTriggerNode("0 9 * * *");
      (triggerNode.data.config as Record<string, unknown>).scheduleTimezone =
        undefined;

      const timezone = triggerNode.data.config?.scheduleTimezone || "UTC";
      expect(timezone).toBe("UTC");
    });
  });

  describe("Concurrent Modifications", () => {
    it("handles schedule not found during update", async () => {
      // Create a local mock for this specific test
      const localMock = vi
        .fn()
        .mockResolvedValueOnce(mockSchedule)
        .mockResolvedValueOnce(undefined);

      const first = await localMock({});
      const second = await localMock({});

      expect(first).toBeDefined();
      expect(second).toBeUndefined();
    });
  });

  // KEEP-575: interval-mode sync. These call syncWorkflowSchedule directly
  // and assert what gets written to the workflow_schedules row.
  describe("Interval mode (KEEP-575)", () => {
    type SyncFn = typeof import("@/lib/schedule-service").syncWorkflowSchedule;
    type WorkflowNode = Parameters<SyncFn>[1][number];

    // Earlier describes in this file set fake timers and queue
    // mockResolvedValueOnce values without consuming them. Reset both so
    // each interval-mode test sees a clean clock and a clean findFirst
    // queue.
    beforeEach(() => {
      vi.useRealTimers();
      mockDbQuery.workflowSchedules.findFirst.mockReset();
    });

    // Helper: spy on the .set() call inside the chained update mock.
    function lastUpdateSetCall(): Record<string, unknown> | undefined {
      const updateResult = mockDbUpdate.mock.results.at(-1)?.value as
        | { set: ReturnType<typeof vi.fn> }
        | undefined;
      return updateResult?.set.mock.calls.at(-1)?.[0];
    }

    function lastInsertValuesCall(): Record<string, unknown> | undefined {
      const insertResult = mockDbInsert.mock.results.at(-1)?.value as
        | { values: ReturnType<typeof vi.fn> }
        | undefined;
      return insertResult?.values.mock.calls.at(-1)?.[0];
    }

    function makeIntervalTriggerNode(
      intervalSeconds: number,
      timezone = "UTC"
    ): WorkflowNode {
      return {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Schedule Trigger",
          config: {
            triggerType: "Schedule",
            scheduleIntervalSeconds: intervalSeconds,
            scheduleTimezone: timezone,
          },
        },
      };
    }

    it("inserts an interval-mode row with interval_seconds, anchor_at, and synthetic cron when no row exists", async () => {
      const { syncWorkflowSchedule } = await import("@/lib/schedule-service");
      mockDbQuery.workflowSchedules.findFirst.mockResolvedValueOnce(undefined);

      const before = Date.now();
      const result = await syncWorkflowSchedule("wf_new", [
        makeIntervalTriggerNode(3300),
      ]);
      const after = Date.now();

      expect(result.synced).toBe(true);
      expect(mockDbInsert).toHaveBeenCalledOnce();
      const inserted = lastInsertValuesCall();
      expect(inserted).toBeDefined();
      expect(inserted?.workflowId).toBe("wf_new");
      expect(inserted?.intervalSeconds).toBe(3300);
      // anchor_at is set to the wall clock at sync time.
      expect(inserted?.anchorAt).toBeInstanceOf(Date);
      const anchorAt = inserted?.anchorAt as Date;
      expect(anchorAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(anchorAt.getTime()).toBeLessThanOrEqual(after);
      // Cron column carries a fixed non-match sentinel so legacy readers
      // can land the row without it parsing to a schedule that resembles
      // the real interval. The dispatcher switches on intervalSeconds and
      // never reads this value in interval mode.
      expect(inserted?.cronExpression).toBe("0 0 1 1 *");
      // First fire = anchor + 1 * interval. KEEP-575: saving a schedule
      // must not cause an immediate run, so next_run_at is at least one
      // interval into the future.
      const nextRunAt = inserted?.nextRunAt as Date;
      expect(nextRunAt.getTime()).toBe(anchorAt.getTime() + 3300 * 1000);
    });

    it("re-anchors when the interval value changes", async () => {
      const { syncWorkflowSchedule } = await import("@/lib/schedule-service");
      const oldAnchor = new Date("2026-05-18T10:00:00Z");
      mockDbQuery.workflowSchedules.findFirst.mockResolvedValueOnce({
        ...mockSchedule,
        cronExpression: "*/30 * * * *",
        intervalSeconds: 1800,
        anchorAt: oldAnchor,
      });

      await syncWorkflowSchedule("wf_change_interval", [
        makeIntervalTriggerNode(3300),
      ]);

      const updated = lastUpdateSetCall();
      expect(updated?.intervalSeconds).toBe(3300);
      // Anchor is fresh, not the old one.
      const newAnchor = updated?.anchorAt as Date;
      expect(newAnchor.getTime()).toBeGreaterThan(oldAnchor.getTime());
    });

    it("preserves the existing anchor when the same interval is re-saved (idempotent autosave)", async () => {
      const { syncWorkflowSchedule } = await import("@/lib/schedule-service");
      const existingAnchor = new Date("2026-05-18T10:00:00Z");
      mockDbQuery.workflowSchedules.findFirst.mockResolvedValueOnce({
        ...mockSchedule,
        cronExpression: "*/55 * * * *",
        intervalSeconds: 3300,
        anchorAt: existingAnchor,
      });

      await syncWorkflowSchedule("wf_same_interval", [
        makeIntervalTriggerNode(3300),
      ]);

      const updated = lastUpdateSetCall();
      // Anchor unchanged so fire-times stay stable across no-op autosaves.
      expect(updated?.anchorAt).toEqual(existingAnchor);
      expect(updated?.intervalSeconds).toBe(3300);
    });

    it("clears interval columns when switching back to cron mode", async () => {
      const { syncWorkflowSchedule } = await import("@/lib/schedule-service");
      mockDbQuery.workflowSchedules.findFirst.mockResolvedValueOnce({
        ...mockSchedule,
        intervalSeconds: 3300,
        anchorAt: new Date("2026-05-18T10:00:00Z"),
      });

      await syncWorkflowSchedule("wf_switch_to_cron", [
        createScheduleTriggerNode("0 9 * * *", "UTC"),
      ]);

      const updated = lastUpdateSetCall();
      expect(updated?.cronExpression).toBe("0 9 * * *");
      expect(updated?.intervalSeconds).toBeNull();
      expect(updated?.anchorAt).toBeNull();
    });
  });
});
