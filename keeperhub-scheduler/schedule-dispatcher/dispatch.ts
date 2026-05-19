/**
 * Schedule dispatcher logic.
 *
 * Pure functions extracted from index.ts so they can be unit-tested in
 * isolation. index.ts is now only the entry point: it composes these
 * functions, registers signal handlers, and runs the polling loop.
 *
 * Note: importing this module triggers SQS client instantiation as a
 * side effect (via lib/sqs-client.js, which calls `new SQSClient(...)` at
 * module load). The functions below are pure, but the import is not.
 * Tests must mock "../lib/sqs-client.js" to avoid contacting AWS.
 */

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { CronExpressionParser } from "cron-parser";
import {
  KEEPERHUB_URL,
  SERVICE_API_KEY,
  SQS_QUEUE_URL,
} from "../lib/config.js";
import { sqs } from "../lib/sqs-client.js";
import type { Schedule, ScheduleMessage } from "../lib/types.js";

export type DispatchResult = {
  evaluated: number;
  triggered: number;
  errors: number;
};

export async function fetchSchedules(): Promise<Schedule[]> {
  const response = await fetch(`${KEEPERHUB_URL}/api/internal/schedules`, {
    method: "GET",
    headers: {
      "X-Service-Key": SERVICE_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch schedules: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as { schedules: Schedule[] };
  return data.schedules;
}

/**
 * Returns true when the cron expression's most recent occurrence is within
 * the current minute (now - prev < 60_000ms). Returns false on invalid
 * expressions and logs the error.
 */
export function shouldTriggerNow(
  cronExpression: string,
  timezone: string,
  now: Date,
): boolean {
  try {
    // cron-parser's prev() is strict — at exactly 09:00:00.000 with cron
    // `0 9 * * *`, prev() returns yesterday's 9am rather than today's, so
    // a dispatch tick that happens to land on a minute boundary skips the
    // schedule. Bump currentDate by 1ms so an occurrence at exactly `now`
    // is treated as in the past.
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(now.getTime() + 1),
      tz: timezone,
    });

    const prev = interval.prev().toDate();
    const diffMs = now.getTime() - prev.getTime();

    return diffMs >= 0 && diffMs < 60_000;
  } catch (error) {
    console.error(`Invalid cron expression: ${cronExpression}`, error);
    return false;
  }
}

/**
 * KEEP-575: returns true when an interval schedule's k-th fire (anchorAt +
 * k * intervalSeconds, k >= 1) lands within the current minute. Mirrors the
 * 60s window used by the cron path so the dispatcher's per-minute polling
 * can fire each occurrence exactly once.
 *
 * The first fire is at `anchor + 1 * interval`, not at the anchor itself —
 * saving a schedule must not cause an immediate run before the user's
 * intended interval has elapsed. This also keeps `shouldTriggerInterval`
 * consistent with the `next_run_at` value `syncWorkflowSchedule` writes on
 * create.
 *
 * Returns false (without firing) if the schedule hasn't reached its first
 * fire yet, or if the inputs are unusable.
 */
export function shouldTriggerInterval(
  intervalSeconds: number,
  anchorAt: Date,
  now: Date,
): boolean {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return false;
  }

  const anchorMs = anchorAt.getTime();
  // KEEP-575: anchorAt arrives as `new Date(schedule.anchorAt)` where
  // schedule.anchorAt is a string from the JSON API. Invalid strings
  // produce Invalid Date and getTime() = NaN, which would make every
  // comparison below silently false — looking like "schedule isn't due
  // yet" forever. Treat a bad anchor as a non-firing input, same as a
  // bad interval.
  if (!Number.isFinite(anchorMs)) {
    return false;
  }

  const nowMs = now.getTime();
  const intervalMs = intervalSeconds * 1000;
  const elapsedMs = nowMs - anchorMs;

  // First fire is at anchor + 1*interval. Anything before that is "waiting".
  if (elapsedMs < intervalMs) {
    return false;
  }

  const sinceMostRecentMs = elapsedMs % intervalMs;

  return sinceMostRecentMs < 60_000;
}

/**
 * KEEP-575: true when the row is in interval mode (intervalSeconds is set
 * to a usable positive number AND anchorAt is present). Strict null/undefined
 * checks instead of truthy `&&` so an accidental zero in the column doesn't
 * silently route through the cron path.
 */
function isIntervalMode(
  schedule: Schedule,
): schedule is Schedule & { intervalSeconds: number; anchorAt: string } {
  const { intervalSeconds, anchorAt } = schedule;
  return (
    intervalSeconds !== null &&
    intervalSeconds !== undefined &&
    intervalSeconds > 0 &&
    anchorAt !== null &&
    anchorAt !== undefined
  );
}

/**
 * KEEP-575: pick interval vs cron dispatch based on whether the schedule
 * has an `intervalSeconds` populated. Interval rows synthesize a placeholder
 * cron expression for legacy readers — the dispatcher must NOT parse that
 * when intervalSeconds is set.
 */
function scheduleShouldTrigger(schedule: Schedule, now: Date): boolean {
  if (isIntervalMode(schedule)) {
    return shouldTriggerInterval(
      schedule.intervalSeconds,
      new Date(schedule.anchorAt),
      now,
    );
  }
  return shouldTriggerNow(schedule.cronExpression, schedule.timezone, now);
}

function describeSchedule(schedule: Schedule): string {
  if (isIntervalMode(schedule)) {
    return `interval: every ${schedule.intervalSeconds}s, anchor: ${schedule.anchorAt}`;
  }
  return `cron: ${schedule.cronExpression}`;
}

export async function sendToQueue(message: ScheduleMessage): Promise<void> {
  const command = new SendMessageCommand({
    QueueUrl: SQS_QUEUE_URL,
    MessageBody: JSON.stringify(message),
    MessageAttributes: {
      TriggerType: {
        DataType: "String",
        StringValue: "schedule",
      },
      WorkflowId: {
        DataType: "String",
        StringValue: message.workflowId,
      },
    },
  });

  await sqs.send(command);
}

/**
 * One dispatch pass: fetch schedules, evaluate each against the current
 * time, enqueue triggers for matching ones. Per-schedule failures are
 * logged and counted but do not abort the pass.
 */
export async function dispatch(): Promise<DispatchResult> {
  const runId = crypto.randomUUID().slice(0, 8);
  console.log(
    `[${runId}] Starting dispatch run at ${new Date().toISOString()}`,
  );

  const schedules = await fetchSchedules();

  console.log(`[${runId}] Found ${schedules.length} enabled schedules`);

  const now = new Date();
  let triggered = 0;
  let errors = 0;

  for (const schedule of schedules) {
    try {
      const shouldTrigger = scheduleShouldTrigger(schedule, now);

      if (shouldTrigger) {
        const description = describeSchedule(schedule);
        console.log(
          `[${runId}] Triggering workflow ${schedule.workflowId} ` +
            `(${description}, tz: ${schedule.timezone})`,
        );

        await sendToQueue({
          workflowId: schedule.workflowId,
          scheduleId: schedule.id,
          triggerTime: now.toISOString(),
          triggerType: "schedule",
        });

        triggered += 1;
      }
    } catch (error) {
      console.error(
        `[${runId}] Error processing schedule ${schedule.id}:`,
        error,
      );
      errors += 1;
    }
  }

  console.log(
    `[${runId}] Dispatch complete: evaluated=${schedules.length}, triggered=${triggered}, errors=${errors}`,
  );

  return {
    evaluated: schedules.length,
    triggered,
    errors,
  };
}
