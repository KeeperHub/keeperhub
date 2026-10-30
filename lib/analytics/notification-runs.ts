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

// Failure notifications as rows in the analytics runs table, one per delivery.
// Pure for testing; the SQL lives in notification-runs-query.ts.

/** Delivery state as run status: capped (plan refused) is "skipped", skipped (withdrawn) is "cancelled". */
const STATUS_BY_STATE: Record<FailureAlertDeliveryState, NormalizedStatus> = {
  delivered: "success",
  failed: "error",
  capped: "skipped",
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

/** Network, gas and duration filters exclude notifications rather than match all. */
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

/** e.g. "Alert: Nightly sync", "Alert: 3 workflows", "Notifications turned on". */
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

/** One delivery as a run row; grouped ids whose incident is gone are dropped. */
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
    // Delivery time is not a run duration.
    durationMs: null,
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
