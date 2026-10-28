import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertDeliveries,
  workflowFailureAlertQueue,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { BACKLOG_ALERT_MS } from "./constants";
import { isFailureAlertsRolloutActive } from "./rollout";

/**
 * Run from another cron (the reaper) so a stopped failure-alerts job is still
 * noticed: work waiting past BACKLOG_ALERT_MS pages our on-call.
 */
export async function checkFailureAlertsRunning(): Promise<{
  queueLagMs: number;
  outboxLagMs: number;
}> {
  if (!isFailureAlertsRolloutActive()) {
    return { queueLagMs: 0, outboxLagMs: 0 };
  }
  const rows = await db.execute<{ queue_lag: number; outbox_lag: number }>(sql`
    SELECT
      COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(due_at)) * 1000
        FROM ${workflowFailureAlertQueue} WHERE due_at <= now()), 0) AS queue_lag,
      COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(next_attempt_at)) * 1000
        FROM ${failureAlertDeliveries}
        WHERE state IN ('pending', 'retrying') AND next_attempt_at <= now()), 0) AS outbox_lag
  `);
  const row = [...rows][0];
  const queueLagMs = Number(row?.queue_lag ?? 0);
  const outboxLagMs = Number(row?.outbox_lag ?? 0);
  if (queueLagMs > BACKLOG_ALERT_MS || outboxLagMs > BACKLOG_ALERT_MS) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[FailureAlerts] Failure notifications are not being processed",
      new Error(
        `oldest queued workflow ${Math.round(queueLagMs / 60_000)} min, oldest due message ${Math.round(outboxLagMs / 60_000)} min`
      ),
      { endpoint: "/api/internal/reaper" }
    );
  }
  return { queueLagMs, outboxLagMs };
}
