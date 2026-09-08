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
import { SQS_QUEUE_URL } from "../lib/config.js";
import { apiRequest } from "../lib/http-client.js";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../lib/phantom.js";
import { sqs } from "../lib/sqs-client.js";
import { signSqsMessageAttributes } from "../lib/sqs-message-auth.js";
import type { Schedule, ScheduleMessage } from "../lib/types.js";
import {
  errorsTotal,
  refusedTotal,
  runDurationSeconds,
  runsTotal,
  triggeredTotal,
} from "./metrics.js";

export type DispatchResult = {
  evaluated: number;
  triggered: number;
  errors: number;
};

export async function fetchSchedules(): Promise<Schedule[]> {
  const data = await apiRequest<{ schedules: Schedule[] }>(
    "/api/internal/schedules",
  );
  return data.schedules;
}

/**
 * Returns all cron occurrences in the half-open interval (from, to].
 * Returns an empty array on parse failure (logs the error) or if there are
 * no occurrences in the window.
 */
export function cronOccurrencesBetween(
  cronExpression: string,
  timezone: string,
  from: Date,
  to: Date,
): Date[] {
  const occurrences: Date[] = [];
  let interval: ReturnType<typeof CronExpressionParser.parse>;
  try {
    interval = CronExpressionParser.parse(cronExpression, {
      currentDate: from,
      tz: timezone,
    });
  } catch (error) {
    console.error(`Invalid cron expression: ${cronExpression}`, error);
    return occurrences;
  }
  for (;;) {
    let next: Date;
    try {
      next = interval.next().toDate();
    } catch (_e) {
      break; // bounded expression exhausted; treat as end of range
    }
    if (next > to) break;
    occurrences.push(next);
  }
  return occurrences;
}

/**
 * Returns all interval-mode occurrences in the half-open interval (from, to].
 *
 * The k-th occurrence is at anchorAt + k * intervalSeconds (k >= 1). The
 * first fire is at anchor + 1 * interval — creating a schedule does not
 * cause an immediate run (mirrors shouldTriggerInterval and syncWorkflowSchedule).
 */
export function intervalOccurrencesBetween(
  intervalSeconds: number,
  anchorAt: Date,
  from: Date,
  to: Date,
): Date[] {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return [];
  }
  const anchorMs = anchorAt.getTime();
  if (!Number.isFinite(anchorMs)) {
    return [];
  }

  const intervalMs = intervalSeconds * 1000;
  const fromMs = from.getTime();
  const toMs = to.getTime();

  // Largest k where anchorMs + k * intervalMs <= fromMs. All k > kFloor
  // produce occurrences strictly after `from`, satisfying (from, to].
  const kFloor = Math.floor((fromMs - anchorMs) / intervalMs);
  const kStart = Math.max(1, kFloor + 1);
  const kEnd = Math.floor((toMs - anchorMs) / intervalMs);

  if (kEnd < kStart) {
    return [];
  }

  const occurrences: Date[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    occurrences.push(new Date(anchorMs + k * intervalMs));
  }
  return occurrences;
}

/**
 * @deprecated Use cronOccurrencesBetween / intervalOccurrencesBetween.
 *
 * Returns true when the cron expression's most recent occurrence is within
 * the current minute (now - prev < 60_000ms). Returns false on invalid
 * expressions and logs the error.
 *
 * Kept for the direct unit tests that exercise it; dispatch() uses the
 * occurrence-based path.
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
 * @deprecated Use cronOccurrencesBetween / intervalOccurrencesBetween.
 *
 * KEEP-575: returns true when an interval schedule's k-th fire (anchorAt +
 * k * intervalSeconds, k >= 1) lands within the current minute.
 *
 * Kept for the direct unit tests that exercise it; dispatch() uses the
 * occurrence-based path.
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
  if (!Number.isFinite(anchorMs)) {
    return false;
  }

  const nowMs = now.getTime();
  const intervalMs = intervalSeconds * 1000;
  const elapsedMs = nowMs - anchorMs;

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
 * Returns all occurrences of this schedule in the half-open interval (from, to].
 * KEEP-575: routes interval vs cron based on whether intervalSeconds is set.
 */
function scheduleOccurrencesBetween(
  schedule: Schedule,
  from: Date,
  to: Date,
): Date[] {
  if (isIntervalMode(schedule)) {
    return intervalOccurrencesBetween(
      schedule.intervalSeconds,
      new Date(schedule.anchorAt),
      from,
      to,
    );
  }
  return cronOccurrencesBetween(
    schedule.cronExpression,
    schedule.timezone,
    from,
    to,
  );
}

function describeSchedule(schedule: Schedule): string {
  if (isIntervalMode(schedule)) {
    return `interval: every ${schedule.intervalSeconds}s, anchor: ${schedule.anchorAt}`;
  }
  return `cron: ${schedule.cronExpression}`;
}

export async function sendToQueue(message: ScheduleMessage): Promise<void> {
  const body = JSON.stringify(message);
  const command = new SendMessageCommand({
    QueueUrl: SQS_QUEUE_URL,
    MessageBody: body,
    MessageAttributes: {
      TriggerType: {
        DataType: "String",
        StringValue: "schedule",
      },
      WorkflowId: {
        DataType: "String",
        StringValue: message.workflowId,
      },
      ...signSqsMessageAttributes("scheduler", SQS_QUEUE_URL, body),
    },
  });

  await sqs.send(command);
}

/**
 * One dispatch pass: stamp now before any I/O, fetch schedules, evaluate
 * each against the window (from, now], enqueue a trigger for every matching
 * occurrence. Per-schedule failures are logged and counted but do not abort
 * the pass.
 *
 * `lastTickAt` is the `now` value from the previous pass. When provided,
 * the window covers every cron occurrence since the last tick (catch-up).
 * When null/undefined the window falls back to a synthetic
 * (now - 60_000ms, now] which is equivalent to the previous single-minute
 * check and is always safe on a fresh startup.
 *
 * `now` is stamped at the very top of this function, before the DB fetch,
 * so DB latency cannot shrink the window and cause a missed trigger.
 */
export async function dispatch(
  lastTickAt?: Date | null,
): Promise<DispatchResult> {
  const runId = crypto.randomUUID().slice(0, 8);

  // Stamp now before any I/O so DB latency cannot push it past the window.
  const now = new Date();
  const from = lastTickAt ?? new Date(now.getTime() - 60_000);

  console.log(
    `[${runId}] Starting dispatch run at ${now.toISOString()}, window: (${from.toISOString()}, ${now.toISOString()}]`,
  );

  const startMs = Date.now();
  let schedules: Schedule[];

  try {
    schedules = await fetchSchedules();
  } catch (error) {
    runDurationSeconds.observe((Date.now() - startMs) / 1000);
    throw error;
  }

  console.log(`[${runId}] Found ${schedules.length} enabled schedules`);

  let triggered = 0;
  let errors = 0;

  for (const schedule of schedules) {
    try {
      const occurrences = scheduleOccurrencesBetween(schedule, from, now);

      for (const occurrence of occurrences) {
        const description = describeSchedule(schedule);
        console.log(
          `[${runId}] Triggering workflow ${schedule.workflowId} ` +
            `(${description}, tz: ${schedule.timezone}, occurrence: ${occurrence.toISOString()})`,
        );

        // KEEP-693: pre-create a phantom row (best-effort) so the run is
        // visible even if it never reaches the executor, and carry its id on
        // the message so the executor upgrades that row instead of inserting.
        // The dispatch key is stable for a given (schedule, occurrence), so an
        // overlapping leader or a catch-up window that
        // recomputes this occurrence collides on the unique index and we skip
        // the duplicate enqueue below.
        const dispatchKey = `schedule:${schedule.id}:${occurrence.toISOString()}`;
        const { executionId, alreadyExisted, refused } =
          await createPhantomExecution(
            schedule.workflowId,
            "schedule",
            undefined,
            dispatchKey,
          );

        // Refused on plan grounds: the executor would refuse the same run, so
        // enqueueing costs an SQS message and an executor round-trip to reach
        // the same answer. The refusal is already recorded for the author.
        if (refused) {
          console.log(
            `[${runId}] Skipping refused dispatch for ${dispatchKey} (${refused})`,
          );
          refusedTotal.inc({ reason: refused });
          continue;
        }

        if (alreadyExisted) {
          console.log(
            `[${runId}] Skipping duplicate dispatch for ${dispatchKey} (already enqueued)`,
          );
          continue;
        }

        try {
          await sendToQueue({
            workflowId: schedule.workflowId,
            scheduleId: schedule.id,
            triggerTime: occurrence.toISOString(),
            triggerType: "schedule",
            executionId,
          });
        } catch (sendError) {
          // The enqueue failed after the phantom was created — resolve it to a
          // coded failure so it surfaces in the run logs, then re-throw so the
          // outer handler counts the error.
          if (executionId) {
            const reason =
              sendError instanceof Error ? sendError.message : "send failed";
            await failPhantomExecution(
              executionId,
              "CS-0001",
              `Scheduled trigger failed to dispatch: ${reason}`,
            );
          }
          throw sendError;
        }

        triggered += 1;
        triggeredTotal.inc();
      }
    } catch (error) {
      console.error(
        `[${runId}] Error processing schedule ${schedule.id}:`,
        error,
      );
      errors += 1;
      errorsTotal.inc();
    }
  }

  const durationSecs = (Date.now() - startMs) / 1000;
  runDurationSeconds.observe(durationSecs);
  runsTotal.inc();

  console.log(
    `[${runId}] Dispatch complete: evaluated=${schedules.length}, triggered=${triggered}, errors=${errors}, duration=${durationSecs.toFixed(2)}s`,
  );

  return {
    evaluated: schedules.length,
    triggered,
    errors,
  };
}
