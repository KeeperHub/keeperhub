import "server-only";

import { db } from "@/lib/db";
import { failureAlertHeartbeats } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getErrorMessage } from "@/lib/utils";
import {
  type EvaluationStats,
  emptyStats,
  evaluateQueuedWorkflows,
  queueReminders,
} from "./evaluator";
import {
  type DrainStats,
  drainOutbox,
  emptyDrainStats,
  fireBackups,
  runHealthChecks,
} from "./outbox";
import { isFailureAlertsRolloutActive } from "./rollout";

export const EVALUATOR_JOB = "evaluator";

export type CycleReport = EvaluationStats &
  DrainStats & { durationMs: number; disabled?: boolean };

/**
 * One minute's work: evaluate workflows whose runs ended, queue reminders,
 * send what is due, fire backups for what did not get through, and check a
 * few channels silently. Each stage catches its own errors so one failure
 * never stops the others, and the heartbeat is written whatever happens.
 */
export async function runFailureAlertCycle(
  appUrl: string,
  now: Date = new Date()
): Promise<CycleReport> {
  const started = Date.now();
  const evaluation = emptyStats();
  const drain = emptyDrainStats();

  if (!isFailureAlertsRolloutActive()) {
    return { ...evaluation, ...drain, durationMs: 0, disabled: true };
  }

  const errors: string[] = [];
  const stage = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      errors.push(`${name}: ${getErrorMessage(error)}`);
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        `[FailureAlerts] Cycle stage failed: ${name}`,
        error
      );
    }
  };

  await stage("evaluate", () => evaluateQueuedWorkflows(now, evaluation));
  await stage("reminders", () => queueReminders(now, evaluation));
  await stage("deliver", () => drainOutbox(now, appUrl, drain));
  await stage("backups", () => fireBackups(now, drain));
  // Backups queued this cycle go out now rather than a minute later.
  await stage("deliver-backups", () => drainOutbox(now, appUrl, drain));
  await stage("health", () => runHealthChecks(now, drain));

  const durationMs = Date.now() - started;
  await writeHeartbeat(
    durationMs,
    errors.length > 0 ? errors.join("; ") : null
  );
  return { ...evaluation, ...drain, durationMs };
}

async function writeHeartbeat(
  durationMs: number,
  lastError: string | null
): Promise<void> {
  const now = new Date();
  try {
    await db
      .insert(failureAlertHeartbeats)
      .values({
        job: EVALUATOR_JOB,
        lastRunAt: now,
        lastDurationMs: durationMs,
        lastError,
      })
      .onConflictDoUpdate({
        target: failureAlertHeartbeats.job,
        set: { lastRunAt: now, lastDurationMs: durationMs, lastError },
      });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[FailureAlerts] Could not write the heartbeat",
      error
    );
  }
}
