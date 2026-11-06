import type { FailureAlertMessageKind } from "@/lib/db/schema-failure-alerts";
import {
  type HistoryEntry,
  historyBy,
  historyNote,
} from "@/lib/notifications/failure-alerts/view-types";

// Sent alerts rows, one per delivery. Pure for testing; the SQL is in history-rows.ts.

/**
 * Keyset cursor (created time to the microsecond, id): rows share a time, so
 * time alone skips rows. Base64url on the wire.
 */
export type HistoryCursor = { at: string; id: string };

const MICRO_TIME = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROW_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SEPARATOR = "~";

/** A time a Postgres timestamp can hold and that names a real instant. */
function realInstant(at: string): boolean {
  const ms = `${at.slice(0, 23)}Z`;
  const parsed = new Date(ms);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === ms;
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.at}${SEPARATOR}${cursor.id}`, "utf8").toString(
    "base64url"
  );
}

/** The cursor a caller sent, or undefined for anything this log never minted. */
export function parseHistoryCursor(
  raw: string | null | undefined
): HistoryCursor | undefined {
  if (!(raw && BASE64URL.test(raw))) {
    return undefined;
  }
  const parts = Buffer.from(raw, "base64url").toString("utf8").split(SEPARATOR);
  if (parts.length !== 2) {
    return undefined;
  }
  const [at, id] = parts;
  if (!(MICRO_TIME.test(at) && ROW_ID.test(id) && realInstant(at))) {
    return undefined;
  }
  return { at, id };
}

/** Incident ids a grouped alert or reminder covers, from its context. */
export function groupedIncidentIds(
  context: Record<string, unknown> | null
): string[] {
  const ids = context?.incidentIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

export type HistoryRow = {
  id: string;
  kind: FailureAlertMessageKind;
  channel: string;
  recipient: string;
  connectionName: string | null;
  state: string;
  attempts: number;
  isBackup: boolean;
  lastStatus: number | null;
  lastError: string | null;
  context: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
  nextAttemptAt: Date;
  /** The incident's workflow, for a message about one incident. */
  workflowId: string | null;
  workflowName: string | null;
};

type GroupedNames = ReadonlyMap<string, { id: string; name: string }>;

/** The workflows a delivery is about; grouped ids whose incident is gone are dropped. */
function rowWorkflows(
  row: HistoryRow,
  groupedNames: GroupedNames
): { id: string; name: string }[] {
  if (row.workflowId && row.workflowName) {
    return [{ id: row.workflowId, name: row.workflowName }];
  }
  // Mute and removal notices name their workflow in their context.
  const context = row.context ?? {};
  if (
    typeof context.workflowId === "string" &&
    typeof context.workflowName === "string"
  ) {
    return [{ id: context.workflowId, name: context.workflowName }];
  }
  return groupedIncidentIds(row.context)
    .map((id) => groupedNames.get(id))
    .filter((w): w is { id: string; name: string } => Boolean(w));
}

/** One delivery as a notification history entry. */
export function toHistoryEntry(
  row: HistoryRow,
  groupedNames: GroupedNames
): HistoryEntry {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    kind: row.kind,
    channel: row.channel,
    recipient: row.recipient,
    connectionName: row.connectionName,
    isBackup: row.isBackup,
    state: row.state,
    attempts: row.attempts,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    note: historyNote(row.context, row.kind),
    by: historyBy(row.context, row.kind),
    // Filled in by loadHistory, which looks the account up.
    byAccount: null,
    workflows: rowWorkflows(row, groupedNames),
  };
}
