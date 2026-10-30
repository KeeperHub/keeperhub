import "server-only";

import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  integrations,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import { likePattern } from "./like-pattern";
import {
  groupedIncidentIds,
  type NotificationRow,
  notificationStatesFor,
  toNotificationRun,
} from "./notification-runs";
import {
  type KeyedRun,
  keysetTime,
  type RunCursor,
  runCursorCondition,
} from "./run-cursor";
import type { RunQueryFilters } from "./types";

// SQL for notification rows in the runs list. resolveSources (queries.ts) drops
// them for network, gas and duration filters, so those are not handled here.

/** Deliveries about a workflow matching `workflowPredicate` (alias `wf`); both arms join incidents by key. */
function deliveryAboutWorkflow(
  organizationId: string,
  workflowPredicate: SQL
): SQL {
  return sql`(
    EXISTS (
      SELECT 1
        FROM ${workflowFailureIncidents} AS inc
        JOIN ${workflows} AS wf ON wf.id = inc.workflow_id
       WHERE inc.id = ${failureAlertDeliveries.incidentId}
         AND inc.organization_id = ${organizationId}
         AND ${workflowPredicate}
    )
    OR (
      jsonb_typeof(${failureAlertDeliveries.context} -> 'incidentIds') = 'array'
      AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(${failureAlertDeliveries.context} -> 'incidentIds') AS grouped(incident_id)
          JOIN ${workflowFailureIncidents} AS inc ON inc.id = grouped.incident_id
          JOIN ${workflows} AS wf ON wf.id = inc.workflow_id
         WHERE inc.organization_id = ${organizationId}
           AND ${workflowPredicate}
      )
    )
  )`;
}

function searchCondition(term: string, organizationId: string): SQL {
  const pattern = likePattern(term);
  return sql`(
    ${failureAlertDeliveries.id} ILIKE ${pattern} ESCAPE '\\'
    OR ${failureAlertDeliveries.recipient} ILIKE ${pattern} ESCAPE '\\'
    OR ${deliveryAboutWorkflow(
      organizationId,
      sql`wf.name ILIKE ${pattern} ESCAPE '\\'`
    )}
  )`;
}

/** All notification predicates; with a project, a workflow-less notice matches none. */
function notificationConditions(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  filters: RunQueryFilters,
  projectId: string | undefined,
  skipStatuses = false
): SQL[] {
  const conditions: SQL[] = [
    eq(failureAlertDeliveries.organizationId, organizationId),
    gte(failureAlertDeliveries.createdAt, rangeStart),
    lt(failureAlertDeliveries.createdAt, rangeEnd),
  ];
  const statuses = filters.statuses ?? [];
  if (!skipStatuses && statuses.length > 0) {
    const states = notificationStatesFor(statuses);
    conditions.push(
      states.length > 0
        ? inArray(failureAlertDeliveries.state, states)
        : sql`false`
    );
  }
  const search = filters.search?.trim();
  if (search) {
    conditions.push(searchCondition(search, organizationId));
  }
  if (projectId) {
    conditions.push(
      deliveryAboutWorkflow(organizationId, sql`wf.project_id = ${projectId}`)
    );
  }
  return conditions;
}

/** Failure notifications as run rows, newest first, named like the notification history. */
export async function fetchNotificationRuns(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  filters: RunQueryFilters,
  cursor: RunCursor | undefined,
  limit: number,
  projectId?: string
): Promise<KeyedRun[]> {
  const conditions = notificationConditions(
    organizationId,
    rangeStart,
    rangeEnd,
    filters,
    projectId
  );
  if (cursor) {
    conditions.push(
      runCursorCondition(
        cursor,
        "notification",
        failureAlertDeliveries.createdAt,
        failureAlertDeliveries.id
      )
    );
  }

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
      lastError: failureAlertDeliveries.lastError,
      context: failureAlertDeliveries.context,
      createdAt: failureAlertDeliveries.createdAt,
      updatedAt: failureAlertDeliveries.updatedAt,
      deliveredAt: failureAlertDeliveries.deliveredAt,
      workflowId: workflowFailureIncidents.workflowId,
      workflowName: workflows.name,
      at: keysetTime(failureAlertDeliveries.createdAt),
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
    .where(and(...conditions))
    .orderBy(
      desc(failureAlertDeliveries.createdAt),
      desc(failureAlertDeliveries.id)
    )
    .limit(limit);

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

  return rows.map(({ at, ...row }) => ({
    run: toNotificationRun(row satisfies NotificationRow, groupedNames),
    at,
  }));
}

export async function getNotificationRunsTotal(
  organizationId: string,
  rangeStart: Date,
  rangeEnd: Date,
  filters: RunQueryFilters,
  projectId?: string
): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(failureAlertDeliveries)
    .where(
      and(
        ...notificationConditions(
          organizationId,
          rangeStart,
          rangeEnd,
          filters,
          projectId
        )
      )
    );
  return Number(result[0]?.count) || 0;
}

/** Newest updated_at in the window for the SSE checksum, so settled deliveries refresh too. */
export async function newestNotificationChange(
  organizationId: string,
  rangeStart: Date
): Promise<string> {
  const result = await db
    .select({
      maxUpdated: sql<string>`COALESCE(MAX(${failureAlertDeliveries.updatedAt}), '1970-01-01')::text`,
    })
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, organizationId),
        gte(failureAlertDeliveries.createdAt, rangeStart)
      )
    );
  return result[0]?.maxUpdated ?? "";
}
