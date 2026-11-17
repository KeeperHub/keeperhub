import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertDeliveries,
  failureAlertHeartbeat,
  workflowExecutions,
  workflowFailureAlertQueue,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  BACKLOG_ALERT_MS,
  EVALUATE_HEARTBEAT,
  HEARTBEAT_STALE_MS,
  RUN_QUEUE_GRACE_MS,
} from "./constants";
import { isFailureAlertsRolloutActive } from "./rollout";

/** The triggers alerts depend on; a dropped or disabled one stops alerts silently. */
const ALERT_TRIGGERS = [
  { table: "workflow_executions", name: "queue_alert_check" },
  { table: "workflows", name: "mark_alert_incident_reenabled" },
] as const;

type WatchdogReport = {
  queueLagMs: number;
  outboxLagMs: number;
  /** Triggers missing or not firing (tgenabled other than O or A). */
  triggersOff: string[];
  /** Runs ended, yet no trigger-fed queue row was taken since: the trigger is failing. */
  queueSilent: boolean;
};

function page(message: string, detail: string): void {
  logSystemError(
    ErrorCategory.INFRASTRUCTURE,
    `[FailureAlerts] ${message}`,
    new Error(detail),
    { endpoint: "/api/internal/reaper" }
  );
}

/** Runs from the reaper cron so a stopped alerts job still pages our on-call. */
export async function checkFailureAlertsRunning(): Promise<WatchdogReport> {
  if (!isFailureAlertsRolloutActive()) {
    return {
      queueLagMs: 0,
      outboxLagMs: 0,
      triggersOff: [],
      queueSilent: false,
    };
  }
  const staleSecs = HEARTBEAT_STALE_MS / 1000;
  const graceSecs = RUN_QUEUE_GRACE_MS / 1000;
  const triggersOn = sql.join(
    ALERT_TRIGGERS.map(
      (t) => sql`(SELECT count(*) FROM pg_trigger
        WHERE tgrelid = ${`public.${t.table}`}::regclass
          AND tgname = ${t.name} AND tgenabled IN ('O', 'A')) AS ${sql.identifier(t.name)}`
    ),
    sql`, `
  );
  const rows = await db.execute<
    Record<string, unknown> & {
      queue_lag: number;
      outbox_lag: number;
      runs_ended: boolean;
      fed_recent: boolean;
    }
  >(sql`
    SELECT
      COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(due_at)) * 1000
        FROM ${workflowFailureAlertQueue} WHERE due_at <= now()), 0) AS queue_lag,
      COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(next_attempt_at)) * 1000
        FROM ${failureAlertDeliveries}
        WHERE state IN ('pending', 'retrying') AND next_attempt_at <= now()), 0) AS outbox_lag,
      EXISTS (SELECT 1 FROM ${workflowExecutions}
        WHERE ${workflowExecutions.startedAt} >= now() - make_interval(secs => ${staleSecs})
          AND ${workflowExecutions.completedAt} <= now() - make_interval(secs => ${graceSecs})
          AND ${workflowExecutions.status} IN ('success', 'error', 'skipped')) AS runs_ended,
      COALESCE((SELECT fed_at >= now() - make_interval(secs => ${staleSecs + graceSecs})
        FROM ${failureAlertHeartbeat} WHERE name = ${EVALUATE_HEARTBEAT}), false) AS fed_recent,
      ${triggersOn}
  `);
  const row = [...rows][0];
  const queueLagMs = Number(row?.queue_lag ?? 0);
  const outboxLagMs = Number(row?.outbox_lag ?? 0);
  const triggersOff = ALERT_TRIGGERS.filter(
    (t) => Number(row?.[t.name] ?? 0) === 0
  ).map((t) => `${t.table}.${t.name}`);
  const backlog = queueLagMs > BACKLOG_ALERT_MS;
  // The trigger stamps each ended run's queue row, and a cycle takes it within a minute.
  // A backlog means the evaluator is down instead, which pages on its own.
  const queueSilent = Boolean(row?.runs_ended) && !row?.fed_recent && !backlog;

  if (backlog || outboxLagMs > BACKLOG_ALERT_MS) {
    page(
      "Failure notifications are not being processed",
      `oldest queued workflow ${Math.round(queueLagMs / 60_000)} min, oldest due message ${Math.round(outboxLagMs / 60_000)} min`
    );
  }
  if (triggersOff.length > 0) {
    page(
      "A failure-alert trigger is missing or disabled",
      triggersOff.join(", ")
    );
  }
  if (queueSilent && triggersOff.length === 0) {
    page(
      "Runs are ending but no workflow reached the alert queue",
      `no trigger-fed row taken in ${Math.round(HEARTBEAT_STALE_MS / 60_000)} min; queue_alert_check may be failing or switched off (warnings in the Postgres log)`
    );
  }
  return { queueLagMs, outboxLagMs, triggersOff, queueSilent };
}
