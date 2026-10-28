import type {
  FailureAlertDeliveryState,
  FailureAlertMessageKind,
} from "@/lib/db/schema-failure-alerts";
import {
  FAILURE_ALERT_KIND_LABEL,
  historyNote,
} from "@/lib/notifications/failure-alerts/view-types";
import type {
  NormalizedStatus,
  NotificationRunDetail,
  RunQueryFilters,
  UnifiedRun,
} from "./types";

/**
 * Failure notifications listed beside runs in the analytics runs table: one row
 * per message sent (a delivery), so a reader can see what the org was told and
 * whether it arrived next to the runs that caused it. Pure, so the server query
 * and the table share it and it can be tested without a database.
 */

/**
 * A delivery state as a run status. Skipped is a message withdrawn before it
 * went out (its incident resolved, or what it was about is gone), which is a
 * cancellation, not the run list's "refused by the plan" skip.
 */
const STATUS_BY_STATE: Record<FailureAlertDeliveryState, NormalizedStatus> = {
  delivered: "success",
  failed: "error",
  capped: "error",
  pending: "pending",
  sending: "running",
  retrying: "running",
  skipped: "cancelled",
};

export function notificationStatus(state: string): NormalizedStatus {
  return STATUS_BY_STATE[state as FailureAlertDeliveryState] ?? "pending";
}

/** The delivery states a normalized status selects; empty when none can. */
export function notificationStatesFor(
  statuses: NormalizedStatus[]
): FailureAlertDeliveryState[] {
  const wanted = new Set(statuses);
  return (
    Object.entries(STATUS_BY_STATE) as [
      FailureAlertDeliveryState,
      NormalizedStatus,
    ][]
  )
    .filter(([, status]) => wanted.has(status))
    .map(([state]) => state);
}

/**
 * Notifications have no network, no gas and no run duration, so any of those
 * filters leaves none of them in the list rather than matching all of them.
 */
export function notificationsExcludedBy(filters: RunQueryFilters): boolean {
  return (
    (filters.networks?.length ?? 0) > 0 ||
    (filters.gas?.length ?? 0) > 0 ||
    filters.durationMinMs !== undefined ||
    filters.durationMaxMs !== undefined
  );
}

/** Incident ids a grouped alert or reminder covers, from its context. */
export function groupedIncidentIds(
  context: Record<string, unknown> | null
): string[] {
  const ids = context?.incidentIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

/**
 * "Alert: Nightly sync", "Alert: 3 workflows", "Channel stopped working: Slack
 * #ops", "Notifications turned on".
 */
export function notificationTitle(
  kind: string,
  workflows: { name: string }[],
  note: string | null
): string {
  const label =
    FAILURE_ALERT_KIND_LABEL[kind as FailureAlertMessageKind] ?? kind;
  if (kind === "channel_paused") {
    return note ? `${label}: ${note}` : label;
  }
  if (workflows.length === 1) {
    return `${label}: ${workflows[0].name}`;
  }
  if (workflows.length > 1) {
    return `${label}: ${workflows.length} workflows`;
  }
  return label;
}

export type NotificationRow = {
  id: string;
  kind: string;
  channel: string;
  recipient: string;
  connectionName: string | null;
  state: string;
  attempts: number;
  isBackup: boolean;
  lastError: string | null;
  context: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
  /** The incident's workflow, for a message about one incident. */
  workflowId: string | null;
  workflowName: string | null;
};

const FINISHED_UNDELIVERED = new Set(["failed", "capped", "skipped"]);

function finishedAt(row: NotificationRow): Date | null {
  if (row.deliveredAt) {
    return row.deliveredAt;
  }
  return FINISHED_UNDELIVERED.has(row.state) ? row.updatedAt : null;
}

/**
 * One delivery as a run row. `groupedNames` maps the incident ids grouped
 * messages carry to their workflow; an id with no entry (its incident is gone)
 * is dropped, as the notification history does.
 */
export function toNotificationRun(
  row: NotificationRow,
  groupedNames: ReadonlyMap<string, { id: string; name: string }>
): UnifiedRun {
  const workflows =
    row.workflowId && row.workflowName
      ? [{ id: row.workflowId, name: row.workflowName }]
      : groupedIncidentIds(row.context)
          .map((id) => groupedNames.get(id))
          .filter((w): w is { id: string; name: string } => Boolean(w));
  const note = historyNote(row.context);
  const completed = finishedAt(row);
  const only = workflows.length === 1 ? workflows[0] : null;
  const notification: NotificationRunDetail = {
    title: notificationTitle(row.kind, workflows, note),
    kind: row.kind,
    state: row.state,
    channel: row.channel,
    recipient: row.recipient,
    connectionName: row.connectionName,
    isBackup: row.isBackup,
    attempts: row.attempts,
    lastError: row.lastError,
    note,
    workflows,
  };
  return {
    id: row.id,
    source: "notification",
    status: notificationStatus(row.state),
    startedAt: row.createdAt.toISOString(),
    completedAt: completed?.toISOString() ?? null,
    durationMs: completed
      ? Math.max(0, completed.getTime() - row.createdAt.getTime())
      : null,
    workflowId: only?.id ?? null,
    workflowName: only?.name ?? null,
    directType: null,
    network: null,
    networks: [],
    gasNetworks: [],
    gasCostWei: null,
    transactionHashes: [],
    gasUsedWei: null,
    totalSteps: null,
    completedSteps: null,
    error: null,
    errorCode: null,
    errorType: null,
    errorCategory: null,
    notification,
  };
}
