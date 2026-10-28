import "server-only";

import { db } from "@/lib/db";
import { failureAlertDeliveries } from "@/lib/db/schema";

export type DeliveryInsert = Omit<
  typeof failureAlertDeliveries.$inferInsert,
  "dedupKey"
> & {
  /**
   * What the message is about: `i:<incident>`, `g:<first incident>` for a
   * grouped alert, `launch:<org>`, `paused:<channel>:<when>`. Part of the
   * dedup key, so two different messages never collide and the same one can
   * never be queued twice.
   */
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

export type { Tx };
