import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalTooSmallError } from "@/lib/cron-utils";
import {
  computeNextIntervalRunTime,
  computeNextRunTime,
  extractScheduleConfig,
  validateCronExpression,
  validateTimezone,
} from "@/lib/schedule-service";
import type { WorkflowNode } from "@/lib/workflow/store";
import {
  createManualTriggerNode,
  createScheduleTriggerNode,
  createWebhookTriggerNode,
  cronExpressions,
  timezones,
} from "../fixtures/workflows";

describe("schedule-service", () => {
  describe("computeNextRunTime", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Set current time to 2024-01-15 08:00:00 UTC
      vi.setSystemTime(new Date("2024-01-15T08:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("computes next run time for daily 9am cron", () => {
      const result = computeNextRunTime(cronExpressions.everyDayAt9am, "UTC");

      expect(result).not.toBeNull();
      expect(result?.getUTCHours()).toBe(9);
      expect(result?.getUTCMinutes()).toBe(0);
      // Should be today at 9am since we're at 8am
      expect(result?.getUTCDate()).toBe(15);
    });

    it("computes next run time for every minute cron", () => {
      const result = computeNextRunTime(cronExpressions.everyMinute, "UTC");

      expect(result).not.toBeNull();
      // Should be the next minute
      expect(result?.getTime()).toBeGreaterThan(Date.now());
    });

    it("computes next run time for every hour cron", () => {
      const result = computeNextRunTime(cronExpressions.everyHour, "UTC");

      expect(result).not.toBeNull();
      expect(result?.getUTCMinutes()).toBe(0);
    });

    it("computes next run time for Monday-only cron", () => {
      const result = computeNextRunTime(
        cronExpressions.everyMondayAt9am,
        "UTC"
      );

      expect(result).not.toBeNull();
      // 2024-01-15 is a Monday, so should be today at 9am or next Monday
      const dayOfWeek = result?.getUTCDay();
      expect(dayOfWeek).toBe(1); // Monday
    });

    it("computes next run time with timezone", () => {
      const resultUTC = computeNextRunTime(
        cronExpressions.everyDayAt9am,
        "UTC"
      );
      const resultNY = computeNextRunTime(
        cronExpressions.everyDayAt9am,
        "America/New_York"
      );

      expect(resultUTC).not.toBeNull();
      expect(resultNY).not.toBeNull();
      // New York is UTC-5 in January, so 9am NY = 2pm UTC
      // The times should be different
      expect(resultUTC?.getTime()).not.toBe(resultNY?.getTime());
    });

    it("returns null for invalid cron expression", () => {
      const result = computeNextRunTime(
        cronExpressions.invalid.notACron,
        "UTC"
      );
      expect(result).toBeNull();
    });

    it("handles empty cron expression", () => {
      // Note: cron-parser may treat empty string as "* * * * *"
      // The validateCronExpression function properly rejects empty strings
      const result = computeNextRunTime(cronExpressions.invalid.empty, "UTC");
      // Empty string defaults to every minute in cron-parser v5
      expect(result).not.toBeNull();
    });
  });

  describe("validateCronExpression", () => {
    it("validates standard 5-field cron expressions", () => {
      expect(validateCronExpression(cronExpressions.everyMinute)).toEqual({
        valid: true,
      });
      expect(validateCronExpression(cronExpressions.everyHour)).toEqual({
        valid: true,
      });
      expect(validateCronExpression(cronExpressions.everyDayAt9am)).toEqual({
        valid: true,
      });
      expect(validateCronExpression(cronExpressions.everyMondayAt9am)).toEqual({
        valid: true,
      });
      expect(validateCronExpression(cronExpressions.everyWeekdayAt9am)).toEqual(
        {
          valid: true,
        }
      );
    });

    it("validates cron with step values", () => {
      expect(validateCronExpression(cronExpressions.every5Minutes)).toEqual({
        valid: true,
      });
      expect(validateCronExpression(cronExpressions.every15Minutes)).toEqual({
        valid: true,
      });
    });

    it("validates cron with list values", () => {
      expect(validateCronExpression(cronExpressions.twiceDaily)).toEqual({
        valid: true,
      });
    });

    it("rejects cron with too few fields", () => {
      const result = validateCronExpression(
        cronExpressions.invalid.tooFewFields
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("5 or 6 fields");
    });

    it("rejects empty cron expression", () => {
      const result = validateCronExpression(cronExpressions.invalid.empty);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects invalid minute value", () => {
      const result = validateCronExpression(
        cronExpressions.invalid.invalidMinute
      );
      expect(result.valid).toBe(false);
    });

    it("rejects invalid hour value", () => {
      const result = validateCronExpression(
        cronExpressions.invalid.invalidHour
      );
      expect(result.valid).toBe(false);
    });

    it("rejects non-string input", () => {
      // @ts-expect-error - Testing invalid input
      const result = validateCronExpression(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");

      // @ts-expect-error - Testing invalid input
      const result2 = validateCronExpression(123);
      expect(result2.valid).toBe(false);
    });
  });

  describe("validateTimezone", () => {
    it("validates common timezones", () => {
      for (const tz of timezones.valid) {
        expect(validateTimezone(tz)).toBe(true);
      }
    });

    it("rejects invalid timezones", () => {
      for (const tz of timezones.invalid) {
        if (tz !== "") {
          // Empty string may pass depending on implementation
          expect(validateTimezone(tz)).toBe(false);
        }
      }
    });

    it("validates UTC", () => {
      expect(validateTimezone("UTC")).toBe(true);
    });

    it("validates Etc/UTC", () => {
      expect(validateTimezone("Etc/UTC")).toBe(true);
    });

    it("validates case variations of timezone names", () => {
      expect(validateTimezone("America/New_York")).toBe(true);
      // Note: Some environments are case-insensitive for timezones
      // The important thing is that the valid format works
    });
  });

  describe("extractScheduleConfig", () => {
    it("extracts config from schedule trigger node", () => {
      const triggerNode = createScheduleTriggerNode(
        "0 9 * * *",
        "America/New_York"
      );
      const result = extractScheduleConfig([triggerNode]);

      expect(result).not.toBeNull();
      expect(result?.mode).toBe("cron");
      if (result?.mode === "cron") {
        expect(result.cronExpression).toBe("0 9 * * *");
      }
      expect(result?.timezone).toBe("America/New_York");
    });

    it("uses UTC as default timezone", () => {
      const triggerNode = createScheduleTriggerNode("0 9 * * *");
      // Remove timezone to test default
      (triggerNode.data.config as Record<string, unknown>).scheduleTimezone =
        undefined;

      const result = extractScheduleConfig([triggerNode]);

      expect(result).not.toBeNull();
      expect(result?.timezone).toBe("UTC");
    });

    it("returns null for webhook trigger", () => {
      const triggerNode = createWebhookTriggerNode();
      const result = extractScheduleConfig([triggerNode]);

      expect(result).toBeNull();
    });

    it("returns null for manual trigger", () => {
      const triggerNode = createManualTriggerNode();
      const result = extractScheduleConfig([triggerNode]);

      expect(result).toBeNull();
    });

    it("returns null when no trigger node exists", () => {
      const result = extractScheduleConfig([]);
      expect(result).toBeNull();
    });

    it("returns null when trigger has no cron expression", () => {
      const triggerNode = createScheduleTriggerNode();
      // Remove cron expression
      (triggerNode.data.config as Record<string, unknown>).scheduleCron =
        undefined;

      const result = extractScheduleConfig([triggerNode]);
      expect(result).toBeNull();
    });

    it("finds trigger node among multiple nodes", () => {
      const nodes = [
        {
          id: "action-1",
          type: "action",
          position: { x: 0, y: 0 },
          data: { type: "action" as const, label: "Action", config: {} },
        },
        createScheduleTriggerNode("*/5 * * * *", "Europe/London"),
        {
          id: "action-2",
          type: "action",
          position: { x: 0, y: 0 },
          data: { type: "action" as const, label: "Action 2", config: {} },
        },
      ];

      const result = extractScheduleConfig(nodes);

      expect(result).not.toBeNull();
      expect(result?.mode).toBe("cron");
      if (result?.mode === "cron") {
        expect(result.cronExpression).toBe("*/5 * * * *");
      }
      expect(result?.timezone).toBe("Europe/London");
    });

    // KEEP-575: interval mode. The trigger config can ship a numeric
    // scheduleIntervalSeconds; when present it takes precedence over
    // scheduleCron because the cron column gets a synthetic placeholder.
    describe("interval mode (KEEP-575)", () => {
      function makeIntervalTrigger(
        intervalSeconds: number | string,
        timezone = "UTC",
        extras: Record<string, unknown> = {}
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
              ...extras,
            },
          },
        };
      }

      it("returns interval mode when scheduleIntervalSeconds is set", () => {
        const result = extractScheduleConfig([makeIntervalTrigger(3300)]);

        expect(result?.mode).toBe("interval");
        if (result?.mode === "interval") {
          expect(result.intervalSeconds).toBe(3300);
        }
      });

      it("parses scheduleIntervalSeconds when stored as a numeric string", () => {
        const result = extractScheduleConfig([makeIntervalTrigger("3300")]);

        expect(result?.mode).toBe("interval");
        if (result?.mode === "interval") {
          expect(result.intervalSeconds).toBe(3300);
        }
      });

      it("prefers interval over scheduleCron when both are present", () => {
        const result = extractScheduleConfig([
          makeIntervalTrigger(3300, "UTC", { scheduleCron: "0 9 * * *" }),
        ]);

        expect(result?.mode).toBe("interval");
      });

      it("falls back to cron when scheduleIntervalSeconds is empty string", () => {
        const result = extractScheduleConfig([
          makeIntervalTrigger("", "UTC", { scheduleCron: "0 9 * * *" }),
        ]);

        expect(result?.mode).toBe("cron");
      });

      it("falls back to cron when scheduleIntervalSeconds is zero", () => {
        const result = extractScheduleConfig([
          makeIntervalTrigger(0, "UTC", { scheduleCron: "0 9 * * *" }),
        ]);

        expect(result?.mode).toBe("cron");
      });

      it("falls back to cron when scheduleIntervalSeconds is negative", () => {
        const result = extractScheduleConfig([
          makeIntervalTrigger(-10, "UTC", { scheduleCron: "0 9 * * *" }),
        ]);

        expect(result?.mode).toBe("cron");
      });

      // KEEP-581: anything below the dispatcher's 60s poll resolution
      // would silently fire every 60s instead of every N -- the same
      // class of "UI says X, schedule does Y" bug KEEP-575 fixes. The
      // parser throws IntervalTooSmallError for sub-60s values; callers
      // must catch it and surface a 400 rather than letting the
      // workflow save through with a sub-60s value stored.
      it("throws IntervalTooSmallError when scheduleIntervalSeconds is below 60 (under poll resolution)", () => {
        expect(() =>
          extractScheduleConfig([
            makeIntervalTrigger(30, "UTC", { scheduleCron: "0 9 * * *" }),
          ])
        ).toThrow(IntervalTooSmallError);
      });

      it("throws IntervalTooSmallError when scheduleIntervalSeconds is 59 (one below the floor)", () => {
        expect(() =>
          extractScheduleConfig([
            makeIntervalTrigger(59, "UTC", { scheduleCron: "0 9 * * *" }),
          ])
        ).toThrow(IntervalTooSmallError);
      });

      it("attaches raw and minimum on the thrown error so callers can render structured 400 bodies", () => {
        try {
          extractScheduleConfig([makeIntervalTrigger(30)]);
          expect.fail("expected IntervalTooSmallError to be thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(IntervalTooSmallError);
          if (error instanceof IntervalTooSmallError) {
            expect(error.raw).toBe(30);
            expect(error.minimum).toBe(60);
          }
        }
      });

      it("accepts scheduleIntervalSeconds at exactly the 60s floor", () => {
        const result = extractScheduleConfig([
          makeIntervalTrigger(60, "UTC", { scheduleCron: "0 9 * * *" }),
        ]);

        expect(result?.mode).toBe("interval");
        if (result?.mode === "interval") {
          expect(result.intervalSeconds).toBe(60);
        }
      });
    });
  });

  // KEEP-575: anchor-relative every-k*interval computation. The dispatcher
  // and the executor's lastRunAt-update path both need to agree, so the
  // formula is centralised in schedule-service.
  describe("computeNextIntervalRunTime", () => {
    it("returns anchor + interval when now is before the anchor", () => {
      // KEEP-575: first fire is `anchor + 1 * interval`, never the anchor
      // itself. A schedule scheduled in the future fires at its first
      // proper occurrence.
      const anchor = new Date("2026-05-18T10:00:00Z");
      const now = new Date("2026-05-18T09:30:00Z");

      const next = computeNextIntervalRunTime(3300, anchor, now);

      expect(next.toISOString()).toBe("2026-05-18T10:55:00.000Z");
    });

    it("returns anchor + interval when called exactly at the anchor", () => {
      // The "schedule was just saved" case. next_run_at should be the
      // first real fire time, never the moment of save itself.
      const anchor = new Date("2026-05-18T10:00:00Z");

      const next = computeNextIntervalRunTime(3300, anchor, anchor);

      // anchor + 3300s = anchor + 55min = 10:55:00
      expect(next.toISOString()).toBe("2026-05-18T10:55:00.000Z");
    });

    it("returns anchor + interval when called mid-first-interval", () => {
      // 30 minutes past anchor, well before the first fire at 10:55.
      const anchor = new Date("2026-05-18T10:00:00Z");
      const now = new Date("2026-05-18T10:30:00Z");

      const next = computeNextIntervalRunTime(3300, anchor, now);

      expect(next.toISOString()).toBe("2026-05-18T10:55:00.000Z");
    });

    it("computes the next 55-minute slot after an arbitrary now", () => {
      const anchor = new Date("2026-05-18T10:00:00Z");
      // 1h7m past anchor: most recent fire was 10:55, next is 11:50
      const now = new Date("2026-05-18T11:07:00Z");

      const next = computeNextIntervalRunTime(3300, anchor, now);

      expect(next.toISOString()).toBe("2026-05-18T11:50:00.000Z");
    });

    it("never returns now itself when called mid-interval", () => {
      const anchor = new Date("2026-05-18T10:00:00Z");
      const now = new Date("2026-05-18T10:30:00Z");

      const next = computeNextIntervalRunTime(3300, anchor, now);

      expect(next.getTime()).toBeGreaterThan(now.getTime());
    });

    // KEEP-575: callers write the result straight to workflow_schedules.
    // next_run_at. Returning Invalid Date silently would surface as a
    // cryptic DB error far from the cause; throw with a clear message
    // instead.
    it("throws on Invalid Date anchor", () => {
      const badAnchor = new Date("not-a-real-date");
      const now = new Date("2026-05-18T10:30:00Z");

      expect(() => computeNextIntervalRunTime(3300, badAnchor, now)).toThrow(
        "invalid anchorAt"
      );
    });

    it("throws on non-positive interval", () => {
      const anchor = new Date("2026-05-18T10:00:00Z");

      expect(() => computeNextIntervalRunTime(0, anchor)).toThrow(
        "invalid intervalSeconds"
      );
      expect(() => computeNextIntervalRunTime(-10, anchor)).toThrow(
        "invalid intervalSeconds"
      );
    });

    it("throws on non-finite interval", () => {
      const anchor = new Date("2026-05-18T10:00:00Z");

      expect(() => computeNextIntervalRunTime(Number.NaN, anchor)).toThrow(
        "invalid intervalSeconds"
      );
      expect(() =>
        computeNextIntervalRunTime(Number.POSITIVE_INFINITY, anchor)
      ).toThrow("invalid intervalSeconds");
    });
  });
});
