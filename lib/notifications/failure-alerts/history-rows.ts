import "server-only";

import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { likePattern } from "@/lib/analytics/like-pattern";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  integrations,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import {
  maskAddressesIn,
  stepUpMasker,
} from "@/lib/notifications/org-recipients";
import {
  groupedIncidentIds,
  type HistoryCursor,
  type HistoryRow,
} from "./history-entry";

/** Rows after the cursor, newest first by (created, id). */
export function historyCursorCondition(cursor: HistoryCursor): SQL {
  return sql`(${failureAlertDeliveries.createdAt}, ${failureAlertDeliveries.id}) < (${cursor.at}::timestamp, ${cursor.id}::text)`;
}

/** The `to` filter, matched against what the log shows (a hidden inbox by its wallet login). */
export async function recipientMatches(
  organizationId: string,
  term: string
): Promise<SQL> {
  const plain = sql`${failureAlertDeliveries.recipient} ILIKE ${likePattern(term)} ESCAPE '\\'`;
  const inboxes = await db
    .selectDistinct({ recipient: failureAlertDeliveries.recipient })
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, organizationId),
        eq(failureAlertDeliveries.channel, "email")
      )
    );
  const mask = await stepUpMasker(inboxes.map((r) => r.recipient));
  const needle = term.toLowerCase();
  const hidden: string[] = [];
  const shownMatch: string[] = [];
  for (const { recipient } of inboxes) {
    const shown = mask(recipient);
    if (shown !== recipient) {
      hidden.push(recipient);
      if (shown.toLowerCase().includes(needle)) {
        shownMatch.push(recipient);
      }
    }
  }
  if (hidden.length === 0) {
    return plain;
  }
  const email = eq(failureAlertDeliveries.channel, "email");
  const visible = sql`(${plain} AND NOT (${and(email, inArray(failureAlertDeliveries.recipient, hidden))}))`;
  return shownMatch.length > 0
    ? sql`(${visible} OR ${and(email, inArray(failureAlertDeliveries.recipient, shownMatch))})`
    : visible;
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
      // Provider text can echo the address, so it is masked the same way.
      if (row.lastError) {
        row.lastError = maskAddressesIn(row.lastError, [row.recipient], mask);
      }
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
