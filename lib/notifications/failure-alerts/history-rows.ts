import "server-only";

import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  integrations,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import { stepUpMasker } from "@/lib/notifications/org-recipients";
import {
  groupedIncidentIds,
  type HistoryCursor,
  type HistoryRow,
} from "./history-entry";

/** Rows after the cursor, newest first by (created, id). */
export function historyCursorCondition(cursor: HistoryCursor): SQL {
  return sql`(${failureAlertDeliveries.createdAt}, ${failureAlertDeliveries.id}) < (${cursor.at}::timestamp, ${cursor.id}::text)`;
}

type KeyedHistoryRow = HistoryRow & {
  /** The exact created time the keyset compares; a Date loses microseconds. */
  at: string;
};

/** Deliveries newest first (created, then id), with the workflows grouped ones name. */
export async function loadHistoryRows(
  organizationId: string,
  conditions: SQL[],
  limit: number,
  offset = 0
): Promise<{
  rows: KeyedHistoryRow[];
  groupedNames: Map<string, { id: string; name: string }>;
}> {
  const rows = await db
    .select({
      id: failureAlertDeliveries.id,
      kind: failureAlertDeliveries.kind,
      channel: failureAlertDeliveries.channel,
      recipient: failureAlertDeliveries.recipient,
      connectionName: integrations.name,
      state: failureAlertDeliveries.state,
      attempts: failureAlertDeliveries.attempts,
      isBackup: failureAlertDeliveries.isBackup,
      lastStatus: failureAlertDeliveries.lastStatus,
      lastError: failureAlertDeliveries.lastError,
      context: failureAlertDeliveries.context,
      createdAt: failureAlertDeliveries.createdAt,
      updatedAt: failureAlertDeliveries.updatedAt,
      deliveredAt: failureAlertDeliveries.deliveredAt,
      nextAttemptAt: failureAlertDeliveries.nextAttemptAt,
      workflowId: workflowFailureIncidents.workflowId,
      workflowName: workflows.name,
      at: sql<string>`to_char(${failureAlertDeliveries.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
    })
    .from(failureAlertDeliveries)
    .leftJoin(
      failureAlertChannels,
      eq(failureAlertChannels.id, failureAlertDeliveries.channelId)
    )
    .leftJoin(
      integrations,
      eq(integrations.id, failureAlertChannels.integrationId)
    )
    .leftJoin(
      workflowFailureIncidents,
      eq(workflowFailureIncidents.id, failureAlertDeliveries.incidentId)
    )
    .leftJoin(workflows, eq(workflows.id, workflowFailureIncidents.workflowId))
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, organizationId),
        ...conditions
      )
    )
    .orderBy(
      desc(failureAlertDeliveries.createdAt),
      desc(failureAlertDeliveries.id)
    )
    .limit(limit)
    .offset(offset);

  // Results are shared and cached, so a step-up inbox is masked for everyone.
  const mask = await stepUpMasker(
    rows.filter((r) => r.channel === "email").map((r) => r.recipient)
  );
  for (const row of rows) {
    if (row.channel === "email") {
      row.recipient = mask(row.recipient);
    }
  }

  const groupedIds = new Set<string>();
  for (const row of rows) {
    for (const id of groupedIncidentIds(row.context)) {
      groupedIds.add(id);
    }
  }
  const groupedNames = new Map<string, { id: string; name: string }>();
  if (groupedIds.size > 0) {
    const named = await db
      .select({
        incidentId: workflowFailureIncidents.id,
        id: workflows.id,
        name: workflows.name,
      })
      .from(workflowFailureIncidents)
      .innerJoin(
        workflows,
        eq(workflows.id, workflowFailureIncidents.workflowId)
      )
      .where(
        and(
          eq(workflowFailureIncidents.organizationId, organizationId),
          inArray(workflowFailureIncidents.id, [...groupedIds])
        )
      );
    for (const row of named) {
      groupedNames.set(row.incidentId, { id: row.id, name: row.name });
    }
  }
  return { rows: rows satisfies KeyedHistoryRow[], groupedNames };
}
