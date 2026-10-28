import "server-only";

import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getErrorMessage } from "@/lib/utils";
import {
  closeInactiveIncidents,
  type EvaluationStats,
  emptyStats,
  evaluateQueuedWorkflows,
  queueReminders,
  requeueLostAlerts,
} from "./evaluator";
import {
  type DrainStats,
  drainOutbox,
  emptyDrainStats,
  fireBackups,
  pruneOldRecords,
  runHealthChecks,
} from "./outbox";
import { isFailureAlertsRolloutActive } from "./rollout";

type CycleReport = EvaluationStats &
  DrainStats & { durationMs: number; disabled?: boolean; errors: string[] };

/**
 * One minute's work: evaluate workflows whose runs ended, close incidents of
 * workflows that stopped, queue reminders and lost alerts, send what is due,
 * fire backups for what did not get through, check a few channels silently
 * and prune old history. Each stage catches its own errors so one failure
 * never stops the others; the errors come back in the report so the route can
 * fail the job and our alerting on failed CronJobs sees it.
 */
export async function runFailureAlertCycle(
  appUrl: string,
  now: Date = new Date()
): Promise<CycleReport> {
  const started = Date.now();
  const evaluation = emptyStats();
  const drain = emptyDrainStats();

  if (!isFailureAlertsRolloutActive()) {
    return {
      ...evaluation,
      ...drain,
      durationMs: 0,
      disabled: true,
      errors: [],
    };
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
  await stage("close-inactive", () => closeInactiveIncidents(now, evaluation));
  await stage("requeue-lost", () => requeueLostAlerts(now, evaluation));
  await stage("reminders", () => queueReminders(now, evaluation));
  await stage("deliver", () => drainOutbox(now, appUrl, drain));
  await stage("backups", () => fireBackups(now, drain));
  // Backups queued this cycle go out now rather than a minute later.
  await stage("deliver-backups", () => drainOutbox(now, appUrl, drain));
  await stage("health", () => runHealthChecks(now, drain));
  await stage("prune", () => pruneOldRecords(now));

  return { ...evaluation, ...drain, durationMs: Date.now() - started, errors };
}
