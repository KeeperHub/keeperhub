import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertDeliveries,
  workflowFailureIncidents,
} from "@/lib/db/schema";
import type { RunAlert, UnifiedRun } from "./types";

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

/** Marks each failed run that opened an alert's incident, as the evaluator recorded it. */
export async function attachAlertsSent(
  organizationId: string,
  runs: UnifiedRun[]
): Promise<UnifiedRun[]> {
  const failedIds = runs
    .filter((run) => run.source === "workflow" && FAILED.has(run.status))
    .map((run) => run.id);
  if (failedIds.length === 0) {
    return runs;
  }

  const rows = await db
    .select({
      runId: workflowFailureIncidents.openingExecutionId,
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
        inArray(workflowFailureIncidents.openingExecutionId, failedIds)
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
