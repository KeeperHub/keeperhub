import "server-only";

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertDeliveries,
  workflowExecutions,
  workflowFailureIncidents,
} from "@/lib/db/schema";
import { ERROR_STATUSES } from "@/lib/errors/execution-status";
import type { RunAlert, UnifiedRun } from "./types";

// Incidents a failed run opens; refused and missed runs never ran.
const RUN_TRIGGERS = ["count", "time", "funding"] as const;
const FAILED = new Set(["error", "system_error", "external_error"]);
const IN_FLIGHT = new Set(["pending", "sending", "retrying"]);

function alertOf(states: string[], sentAt: Date, channels: string[]): RunAlert {
  let state: RunAlert["state"] = "failed";
  if (states.includes("delivered")) {
    state = "delivered";
  } else if (states.some((s) => IN_FLIGHT.has(s))) {
    state = "sending";
  }
  return { sentAt: sentAt.toISOString(), channels: channels.sort(), state };
}

/** Marks each failed run that set off an alert: the newest failure before its incident opened. */
export async function attachAlertsSent(
  organizationId: string,
  runs: UnifiedRun[]
): Promise<UnifiedRun[]> {
  const failed = runs.filter(
    (run) =>
      run.source === "workflow" &&
      FAILED.has(run.status) &&
      run.workflowId &&
      run.completedAt
  );
  if (failed.length === 0) {
    return runs;
  }
  const earliest = new Date(
    Math.min(...failed.map((run) => Date.parse(run.completedAt as string)))
  );
  const workflowIds = [
    ...new Set(failed.map((run) => run.workflowId as string)),
  ];

  const triggerRun = sql<string | null>`(
    SELECT e.id FROM ${workflowExecutions} e
     WHERE e.workflow_id = ${workflowFailureIncidents.workflowId}
       AND e.status IN (${sql.join(
         ERROR_STATUSES.map((s) => sql`${s}`),
         sql`, `
       )})
       AND e.completed_at <= ${workflowFailureIncidents.openedAt}
     ORDER BY e.started_at DESC
     LIMIT 1
  )`;
  const rows = await db
    .select({
      runId: triggerRun,
      sentAt: sql<Date>`min(${failureAlertDeliveries.createdAt})`.mapWith(
        failureAlertDeliveries.createdAt
      ),
      channels: sql<
        string[]
      >`array_agg(DISTINCT ${failureAlertDeliveries.channel})`,
      states: sql<
        string[]
      >`array_agg(DISTINCT ${failureAlertDeliveries.state})`,
    })
    .from(workflowFailureIncidents)
    .innerJoin(
      failureAlertDeliveries,
      and(
        eq(failureAlertDeliveries.kind, "alert"),
        eq(failureAlertDeliveries.organizationId, organizationId),
        // Its own alert, or a grouped one that listed it.
        sql`(${failureAlertDeliveries.incidentId} = ${workflowFailureIncidents.id}
          OR ${failureAlertDeliveries.context} @> jsonb_build_object('incidentIds', jsonb_build_array(${workflowFailureIncidents.id})))`
      )
    )
    .where(
      and(
        eq(workflowFailureIncidents.organizationId, organizationId),
        inArray(workflowFailureIncidents.workflowId, workflowIds),
        inArray(workflowFailureIncidents.openedBy, [...RUN_TRIGGERS]),
        gte(workflowFailureIncidents.openedAt, earliest)
      )
    )
    .groupBy(workflowFailureIncidents.id);

  const byRun = new Map<string, RunAlert>();
  for (const row of rows) {
    if (row.runId) {
      byRun.set(row.runId, alertOf(row.states, row.sentAt, row.channels));
    }
  }
  if (byRun.size === 0) {
    return runs;
  }
  return runs.map((run) => {
    const alert = byRun.get(run.id);
    return alert ? { ...run, alert } : run;
  });
}
