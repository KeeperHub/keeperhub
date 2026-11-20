import "server-only";

import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getErrorMessage } from "@/lib/utils";
import { DELIVERY_BUDGET_MS } from "./constants";
import {
  checkMissedSchedules,
  clearQueueWhileOff,
  closeInactiveIncidents,
  type EvaluationStats,
  emptyStats,
  evaluateQueuedWorkflows,
  queueReminders,
  requeueLostAlerts,
} from "./evaluator";
import { endExpiredOrgPauses } from "./org-pause";
import {
  type DrainStats,
  drainOutbox,
  emptyDrainStats,
  fireBackups,
  pruneOldRecords,
  runHealthChecks,
} from "./outbox";
import { isFailureAlertsRolloutActive } from "./rollout";
import { endExpiredWorkflowPauses } from "./workflow-pause-notices";

type CycleReport = EvaluationStats &
  DrainStats & {
    durationMs: number;
    disabled?: boolean;
    errors: string[];
    warnings: string[];
  };

/** Only these fail the CronJob; a failure elsewhere is logged and the cycle goes on. */
const JOB_FAILING_STAGES = new Set([
  "evaluate",
  "deliver",
  "backups",
  "deliver-backups",
]);

/** One minute of alert work; each stage's error is isolated and logged. */
export async function runFailureAlertCycle(
  appUrl: string,
  now: Date = new Date()
): Promise<CycleReport> {
  const started = Date.now();
  const evaluation = emptyStats();
  const drain = emptyDrainStats();

  const errors: string[] = [];
  const warnings: string[] = [];
  const stage = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      const failed = JOB_FAILING_STAGES.has(name) ? errors : warnings;
      failed.push(`${name}: ${getErrorMessage(error)}`);
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        `[FailureAlerts] Cycle stage failed: ${name}`,
        error
      );
    }
  };

  if (!isFailureAlertsRolloutActive()) {
    // No backlog dated back to the deploy waits for the day it turns on.
    await stage("clear-queue", clearQueueWhileOff);
    return {
      ...evaluation,
      ...drain,
      durationMs: Date.now() - started,
      disabled: true,
      errors,
      warnings,
    };
  }

  await stage("end-org-pauses", async () => {
    await endExpiredOrgPauses(now);
  });
  await stage("end-workflow-pauses", async () => {
    await endExpiredWorkflowPauses(now);
  });
  await stage("evaluate", () => evaluateQueuedWorkflows(now, evaluation));
  await stage("missed-schedules", () => checkMissedSchedules(now, evaluation));
  await stage("close-inactive", () => closeInactiveIncidents(now, evaluation));
  await stage("requeue-lost", () => requeueLostAlerts(now, evaluation));
  await stage("reminders", () => queueReminders(now, evaluation));
  const deliveryDeadline = Date.now() + DELIVERY_BUDGET_MS;
  await stage("deliver", () =>
    drainOutbox(appUrl, drain, deliveryDeadline, now)
  );
  await stage("backups", () => fireBackups(now, drain));
  // Backups queued this cycle go out now rather than a minute later.
  await stage("deliver-backups", () =>
    drainOutbox(appUrl, drain, deliveryDeadline, now)
  );
  await stage("health", () => runHealthChecks(now, drain));
  await stage("prune", () => pruneOldRecords(now));

  return {
    ...evaluation,
    ...drain,
    durationMs: Date.now() - started,
    errors,
    warnings,
  };
}
