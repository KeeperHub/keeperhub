import "server-only";

import { db } from "@/lib/db";
import { failureAlertDeliveries } from "@/lib/db/schema";
import type {
  FailureAlertDeliveryChannel,
  FailureAlertMessageKind,
} from "@/lib/db/schema-failure-alerts";
import type { OrgMember } from "@/lib/notifications/org-recipients";
import { BACKUP_AFTER_MS } from "./constants";
import {
  type ChannelConfig,
  type EffectivePolicy,
  resolveRecipientEmails,
} from "./policy";

export type DeliveryInsert = Omit<
  typeof failureAlertDeliveries.$inferInsert,
  "dedupKey"
> & {
  /** Dedup-key subject: `i:<incident>`, `g:<first incident>`, `launch:<org>`, `paused:<channel>:<when>`. */
  scope: string;
};

/** Scope of everything about one incident: alert, reminders, recovery. */
export function incidentScope(incidentId: string): string {
  return `i:${incidentId}`;
}

/** Scope of a grouped alert, named after its first incident. */
export function groupScope(firstIncidentId: string): string {
  return `g:${firstIncidentId}`;
}

/** Who a chat or PagerDuty row is addressed to, for dedup and history. */
export function channelRecipient(channel: {
  kind: string;
  destination: string;
}): string {
  return channel.destination || channel.kind;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function dedupKeyFor(row: DeliveryInsert): string {
  return [
    row.scope,
    row.kind,
    row.sequence ?? 0,
    row.channel,
    row.channelId ?? "",
    row.recipient,
    row.isBackup ? "backup" : "primary",
  ].join("|");
}

/** Insert rows, skipping any already queued. Returns how many were new. */
export async function insertDeliveries(
  rows: DeliveryInsert[],
  tx: Tx | typeof db = db
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const inserted = await tx
    .insert(failureAlertDeliveries)
    .values(
      rows.map(({ scope, ...row }) => ({
        ...row,
        dedupKey: dedupKeyFor({ scope, ...row }),
      }))
    )
    .onConflictDoNothing({ target: failureAlertDeliveries.dedupKey })
    .returning({ id: failureAlertDeliveries.id });
  return inserted.length;
}

/** Rows for one message; with nobody reachable, a failed email row makes backups fire. */
export function buildMessageRows(params: {
  scope: string;
  organizationId: string;
  incidentId: string | null;
  kind: FailureAlertMessageKind;
  sequence: number;
  emails: string[];
  channels: ChannelConfig[];
  includePagerDuty: boolean;
  context?: Record<string, unknown>;
  now: Date;
}): DeliveryInsert[] {
  const base = {
    scope: params.scope,
    organizationId: params.organizationId,
    incidentId: params.incidentId,
    kind: params.kind,
    sequence: params.sequence,
    context: params.context,
    nextAttemptAt: params.now,
  };
  const backupAt = (channel: FailureAlertDeliveryChannel): Date =>
    new Date(params.now.getTime() + BACKUP_AFTER_MS[channel]);

  const rows: DeliveryInsert[] = params.emails.map((email) => ({
    ...base,
    channel: "email",
    recipient: email,
    backupAt: backupAt("email"),
  }));

  for (const channel of params.channels) {
    if (channel.pausedAt || channel.role !== "always") {
      continue;
    }
    if (channel.kind === "pagerduty" && !params.includePagerDuty) {
      continue;
    }
    rows.push({
      ...base,
      channel: channel.kind,
      channelId: channel.id,
      recipient: channelRecipient(channel),
      backupAt: backupAt(channel.kind),
    });
  }

  if (params.emails.length === 0) {
    rows.push({
      ...base,
      channel: "email",
      recipient: "(nobody reachable)",
      state: "failed",
      lastError:
        "Nobody in the organization has an email address KeeperHub can reach.",
      backupAt: params.now,
    });
  }
  return rows;
}

/** One message about one incident, to everyone its policy names. */
export function rowsForPolicy(
  policy: EffectivePolicy,
  members: OrgMember[],
  organizationId: string,
  incidentId: string,
  kind: FailureAlertMessageKind,
  sequence: number,
  now: Date,
  context?: Record<string, unknown>
): DeliveryInsert[] {
  return buildMessageRows({
    scope: incidentScope(incidentId),
    organizationId,
    incidentId,
    kind,
    sequence,
    context,
    emails: resolveRecipientEmails(policy.recipientUserIds, members),
    channels: policy.channels,
    // PagerDuty owns escalation: it gets the incident and its resolve, never
    // our reminders.
    includePagerDuty: kind === "alert",
    now,
  });
}

export type { Tx };
