import { CronExpressionParser } from "cron-parser";
import { eq } from "drizzle-orm";
import {
  IntervalTooSmallError,
  parseIntervalSeconds,
  validateCronExpression,
} from "@/lib/cron-utils";
import { db } from "@/lib/db";
import { workflowSchedules } from "@/lib/db/schema";
import {
  ErrorCategory,
  logSystemError,
  logSystemWarn,
  logUserError,
} from "@/lib/logging";
import { generateId } from "@/lib/utils/id";
import type { WorkflowNode } from "@/lib/workflow/store";

export { validateCronExpression } from "@/lib/cron-utils";

/**
 * Sentinel placeholder written to `cron_expression` when a schedule is in
 * interval mode (KEEP-575). cron_expression is NOT NULL on the table, so
 * interval-mode rows still need a syntactically valid cron string. The
 * dispatcher switches on intervalSeconds first and never parses this; the
 * value exists only to satisfy the column constraint and be obviously
 * not-the-real-schedule for anyone reading the row directly.
 *
 * `0 0 1 1 *` = "00:00 on January 1" — fires once a year, deliberately
 * unrelated to whatever interval the user configured. An earlier attempt
 * derived `*\/N * * * *` from the interval, which would have reproduced
 * the exact bug KEEP-575 fixes inside any non-dispatcher reader (the two
 * standalone scripts in scripts/ that still parse cron_expression). A
 * constant non-match removes that footgun entirely.
 */
const INTERVAL_MODE_CRON_PLACEHOLDER = "0 0 1 1 *";

/**
 * Compute the next run time for a cron expression in a given timezone
 */
export function computeNextRunTime(
  cronExpression: string,
  timezone: string
): Date | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(),
      tz: timezone,
    });
    return interval.next().toDate();
  } catch (error) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      `[Schedule] Invalid cron expression: ${cronExpression}`,
      error,
      {
        component: "schedule-service",
        cron_expression: cronExpression,
      }
    );
    return null;
  }
}

/**
 * Compute the next run time for an interval schedule (KEEP-575).
 *
 * Fires on `anchor + k * intervalSeconds` for k >= 1. The first fire is
 * `anchor + 1 * interval` (saving a schedule must not cause an immediate
 * run before the user's interval has elapsed). Returns the smallest such
 * value strictly greater than `now`, or `anchor + interval` if `now` is
 * not yet past the first fire.
 */
export function computeNextIntervalRunTime(
  intervalSeconds: number,
  anchorAt: Date,
  now: Date = new Date()
): Date {
  // KEEP-575: throw on garbage inputs rather than silently returning an
  // Invalid Date. Callers (syncWorkflowSchedule, updateScheduleAfterRun,
  // the schedule status PATCH route) write the result directly to the
  // workflow_schedules.next_run_at column; returning NaN-as-Date would
  // surface as a cryptic DB error far from the actual cause.
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error(
      `computeNextIntervalRunTime: invalid intervalSeconds ${String(intervalSeconds)}`
    );
  }
  const anchorMs = anchorAt.getTime();
  if (!Number.isFinite(anchorMs)) {
    throw new Error(
      "computeNextIntervalRunTime: invalid anchorAt (getTime returned NaN)"
    );
  }
  const intervalMs = intervalSeconds * 1000;
  const nowMs = now.getTime();
  const firstFireMs = anchorMs + intervalMs;
  // Before the first fire: next fire is anchor + 1*interval.
  if (nowMs < firstFireMs) {
    return new Date(firstFireMs);
  }
  const elapsedMs = nowMs - anchorMs;
  const kNext = Math.floor(elapsedMs / intervalMs) + 1;
  return new Date(anchorMs + kNext * intervalMs);
}

/**
 * Validate timezone string
 */
export function validateTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Discriminated schedule configuration extracted from a trigger node.
 *
 * KEEP-575: interval mode lets us represent "every N minutes" accurately
 * when N doesn't divide 60 — something a single 5-field cron cannot do.
 */
export type ExtractedScheduleConfig =
  | { mode: "cron"; cronExpression: string; timezone: string }
  | { mode: "interval"; intervalSeconds: number; timezone: string };

/**
 * Extract schedule configuration from workflow trigger node
 */
export function extractScheduleConfig(
  nodes: WorkflowNode[]
): ExtractedScheduleConfig | null {
  const triggerNode = nodes.find((n) => n.data.type === "trigger");

  if (!triggerNode) {
    return null;
  }

  const config = triggerNode.data.config;
  if (config?.triggerType !== "Schedule") {
    return null;
  }

  const timezone = (config.scheduleTimezone as string) || "UTC";

  const intervalSecondsRaw = config.scheduleIntervalSeconds;
  const intervalSeconds = parseIntervalSeconds(intervalSecondsRaw);
  if (intervalSeconds !== null) {
    return { mode: "interval", intervalSeconds, timezone };
  }

  const cronExpression = config.scheduleCron as string | undefined;
  if (!cronExpression) {
    return null;
  }

  return { mode: "cron", cronExpression, timezone };
}

/**
 * Outcome of a schedule sync.
 *
 * `kind: "hard"` failures MUST be surfaced to the API caller as a 400.
 * `kind: "soft"` failures are warn-logged; the save itself still
 * succeeds. The discriminator is required (not optional) so that
 * adding a new failure category forces every call site to handle it
 * via exhaustiveness checks instead of silently falling into the
 * default branch.
 */
export type ScheduleSyncResult =
  | { synced: true }
  | { synced: false; kind: "soft"; error: string }
  | {
      synced: false;
      kind: "hard";
      code: "interval_too_small";
      error: string;
    };

/**
 * Sync workflow schedule based on trigger configuration.
 * Called when a workflow is saved.
 */
export async function syncWorkflowSchedule(
  workflowId: string,
  nodes: WorkflowNode[]
): Promise<ScheduleSyncResult> {
  let scheduleConfig: ExtractedScheduleConfig | null;
  try {
    scheduleConfig = extractScheduleConfig(nodes);
  } catch (error) {
    if (error instanceof IntervalTooSmallError) {
      return {
        synced: false,
        kind: "hard",
        code: "interval_too_small",
        error: error.message,
      };
    }
    throw error;
  }

  if (!scheduleConfig) {
    // No schedule trigger - delete any existing schedule
    await db
      .delete(workflowSchedules)
      .where(eq(workflowSchedules.workflowId, workflowId));

    console.log(`[Schedule] Removed schedule for workflow ${workflowId}`);
    return { synced: true };
  }

  const { timezone } = scheduleConfig;

  // Validate timezone (shared by both modes)
  if (!validateTimezone(timezone)) {
    logUserError(
      ErrorCategory.VALIDATION,
      `[Schedule] Invalid timezone for workflow ${workflowId}: ${timezone}`,
      undefined,
      { workflow_id: workflowId }
    );
    return {
      synced: false,
      kind: "soft",
      error: `Invalid timezone: ${timezone}`,
    };
  }

  // Validate the mode-specific payload up front so we never write a half-
  // valid row to the DB.
  if (scheduleConfig.mode === "cron") {
    const cronValidation = validateCronExpression(
      scheduleConfig.cronExpression
    );
    if (!cronValidation.valid) {
      logUserError(
        ErrorCategory.VALIDATION,
        `[Schedule] Invalid cron for workflow ${workflowId}: ${cronValidation.error}`,
        undefined,
        { workflow_id: workflowId }
      );
      return {
        synced: false,
        kind: "soft",
        error: cronValidation.error ?? "Invalid cron expression",
      };
    }
  }

  const existingSchedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.workflowId, workflowId),
  });

  if (scheduleConfig.mode === "cron") {
    const { cronExpression } = scheduleConfig;
    const nextRunAt = computeNextRunTime(cronExpression, timezone);

    if (existingSchedule) {
      await db
        .update(workflowSchedules)
        .set({
          cronExpression,
          intervalSeconds: null,
          anchorAt: null,
          timezone,
          nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(workflowSchedules.workflowId, workflowId));

      console.log(
        `[Schedule] Updated schedule for workflow ${workflowId}: ${cronExpression} (${timezone})`
      );
    } else {
      await db.insert(workflowSchedules).values({
        id: generateId(),
        workflowId,
        cronExpression,
        timezone,
        enabled: true,
        nextRunAt,
      });

      console.log(
        `[Schedule] Created schedule for workflow ${workflowId}: ${cronExpression} (${timezone})`
      );
    }

    return { synced: true };
  }

  // Interval mode (KEEP-575). cron_expression is NOT NULL, so we stash a
  // fixed sentinel placeholder. The dispatcher switches on intervalSeconds
  // and never parses this value; see INTERVAL_MODE_CRON_PLACEHOLDER for why
  // it's a constant non-match rather than a "best-effort" derived cron.
  const { intervalSeconds } = scheduleConfig;

  // Re-anchor only when the interval changes (or when switching modes).
  // Preserving the anchor across no-op autosaves keeps fire-times stable.
  const intervalChanged =
    !existingSchedule ||
    existingSchedule.intervalSeconds !== intervalSeconds ||
    !existingSchedule.anchorAt;
  const anchorAt = intervalChanged
    ? new Date()
    : (existingSchedule?.anchorAt ?? new Date());
  const nextRunAt = computeNextIntervalRunTime(intervalSeconds, anchorAt);

  if (existingSchedule) {
    await db
      .update(workflowSchedules)
      .set({
        cronExpression: INTERVAL_MODE_CRON_PLACEHOLDER,
        intervalSeconds,
        anchorAt,
        timezone,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(workflowSchedules.workflowId, workflowId));

    console.log(
      `[Schedule] Updated schedule for workflow ${workflowId}: every ${intervalSeconds}s (${timezone})`
    );
  } else {
    await db.insert(workflowSchedules).values({
      id: generateId(),
      workflowId,
      cronExpression: INTERVAL_MODE_CRON_PLACEHOLDER,
      intervalSeconds,
      anchorAt,
      timezone,
      enabled: true,
      nextRunAt,
    });

    console.log(
      `[Schedule] Created schedule for workflow ${workflowId}: every ${intervalSeconds}s (${timezone})`
    );
  }

  return { synced: true };
}

/**
 * Sync a schedule for a workflow row that is already committed, warn-logging a
 * soft failure instead of surfacing it. The creation routes and the enable path
 * use this: their write has landed, so a bad timezone or cron expression must
 * not turn into a failed request.
 *
 * Pass the nodes that were persisted, not the raw request body. The sanitizer
 * moves misplaced trigger fields into `data.config` and canonicalises
 * `data.type`, and extractScheduleConfig only recognises that canonical shape.
 */
export async function syncPersistedWorkflowSchedule(
  workflowId: string,
  nodes: WorkflowNode[],
  endpoint: string
): Promise<void> {
  const result = await syncWorkflowSchedule(workflowId, nodes);
  if (!result.synced) {
    logSystemWarn(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Schedule] Schedule sync failed",
      result.error,
      { workflow_id: workflowId, endpoint }
    );
  }
}

/**
 * Get schedule for a workflow
 */
export async function getWorkflowSchedule(
  workflowId: string
): Promise<typeof workflowSchedules.$inferSelect | null> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.workflowId, workflowId),
  });
  return schedule || null;
}

/**
 * Update schedule enabled status.
 *
 * KEEP-575: deliberately does NOT touch anchorAt or nextRunAt. For
 * interval-mode rows, that means the fire phase is preserved across a
 * disable/re-enable: if a "every 55 minutes" schedule is disabled at
 * elapsed=10min and re-enabled an hour later, the next fire still lands
 * on the original anchor + k*interval grid, not 55 minutes from the
 * re-enable moment. No catch-up storm either -- the dispatcher's per-
 * minute polling fires at most once per cycle, so a long-disabled
 * schedule resumes on its next natural slot rather than replaying
 * missed slots. Re-anchoring on enable would surprise users who pause
 * a workflow briefly and expect the same cadence to resume.
 */
export async function setScheduleEnabled(
  workflowId: string,
  enabled: boolean
): Promise<void> {
  await db
    .update(workflowSchedules)
    .set({
      enabled,
      updatedAt: new Date(),
    })
    .where(eq(workflowSchedules.workflowId, workflowId));

  console.log(
    `[Schedule] ${enabled ? "Enabled" : "Disabled"} schedule for workflow ${workflowId}`
  );
}

/**
 * Update schedule after execution
 */
export async function updateScheduleAfterRun(
  scheduleId: string,
  status: "success" | "error",
  error?: string
): Promise<void> {
  const schedule = await db.query.workflowSchedules.findFirst({
    where: eq(workflowSchedules.id, scheduleId),
  });

  if (!schedule) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Schedule] Schedule not found",
      new Error(`Schedule not found: ${scheduleId}`),
      { schedule_id: scheduleId }
    );
    return;
  }

  // KEEP-575: prefer interval mode when intervalSeconds + anchorAt are
  // both populated; strict !== checks so a stray zero in the column cannot
  // silently demote the row to the cron path.
  const intervalSeconds = schedule.intervalSeconds;
  const anchorAt = schedule.anchorAt;
  const isInterval =
    intervalSeconds !== null &&
    intervalSeconds > 0 &&
    anchorAt !== null &&
    anchorAt !== undefined;
  const nextRunAt = isInterval
    ? computeNextIntervalRunTime(intervalSeconds, anchorAt)
    : computeNextRunTime(schedule.cronExpression, schedule.timezone);

  const runCount =
    status === "success"
      ? String(Number(schedule.runCount || "0") + 1)
      : schedule.runCount;

  await db
    .update(workflowSchedules)
    .set({
      lastRunAt: new Date(),
      lastStatus: status,
      lastError: status === "error" ? error : null,
      nextRunAt,
      runCount,
      updatedAt: new Date(),
    })
    .where(eq(workflowSchedules.id, scheduleId));

  console.log(`[Schedule] Updated schedule ${scheduleId} after run: ${status}`);
}
