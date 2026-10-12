import "server-only";

import { db } from "@/lib/db";
import { directExecutions, eventOutbox } from "@/lib/db/schema";
import { isOutboundWebhooksEnabled } from "./feature-flag";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DirectExecutionEventType =
  | "direct_execution.succeeded"
  | "direct_execution.failed";

type DirectExecutionEventColumns = Pick<
  typeof directExecutions,
  | "id"
  | "organizationId"
  | "type"
  | "status"
  | "network"
  | "transactionHash"
  | "error"
  | "completedAt"
>;

/**
 * Columns a status write must return so its event can be built without a
 * second read. Pass to `.returning()`. A function rather than a constant so
 * importing this module never touches the table object.
 */
export function directExecutionEventColumns(): DirectExecutionEventColumns {
  return {
    id: directExecutions.id,
    organizationId: directExecutions.organizationId,
    type: directExecutions.type,
    status: directExecutions.status,
    network: directExecutions.network,
    transactionHash: directExecutions.transactionHash,
    error: directExecutions.error,
    completedAt: directExecutions.completedAt,
  };
}

export type DirectExecutionEventRow = {
  id: string;
  organizationId: string;
  type: string;
  status: string;
  network: string | null;
  transactionHash: string | null;
  error: string | null;
  completedAt: Date | null;
};

/**
 * The event a status describes, or null when it is not final. `unconfirmed`
 * is deliberately not final: the transaction may still land, and the
 * reconciler settles the row later, which is when its event is written.
 */
export function directExecutionEventType(
  status: string
): DirectExecutionEventType | null {
  if (status === "completed") {
    return "direct_execution.succeeded";
  }
  if (status === "failed") {
    return "direct_execution.failed";
  }
  return null;
}

// One final event per execution, whichever way it ended. Keyed on the
// execution alone so a row that somehow ended twice still emits once.
function dedupeKeyFor(executionId: string): string {
  return `direct_execution:${executionId}`;
}

// Mirrors fields GET /api/execute/{executionId}/status already returns, so an
// event never exposes more than the API does.
function eventData(row: DirectExecutionEventRow): Record<string, unknown> {
  return {
    executionId: row.id,
    type: row.type,
    status: row.status,
    network: row.network,
    transactionHash: row.transactionHash,
    error: row.error,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function recordDirectExecutionEvent(
  tx: DbTransaction,
  row: DirectExecutionEventRow
): Promise<void> {
  const eventType = directExecutionEventType(row.status);
  if (!eventType) {
    return;
  }
  await tx
    .insert(eventOutbox)
    .values({
      organizationId: row.organizationId,
      eventType,
      executionId: row.id,
      dedupeKey: dedupeKeyFor(row.id),
      data: eventData(row),
    })
    .onConflictDoNothing({ target: eventOutbox.dedupeKey });
}

/**
 * Applies a direct-execution status write and, in the same transaction,
 * records the outbox event for every row it left in a final state.
 *
 * `write` must run its UPDATE on the transaction it is given and return the
 * affected rows via `.returning(directExecutionEventColumns())`. A write that
 * matched nothing returns no rows and so records nothing, which is what a
 * guarded update that lost a race needs.
 */
export async function writeDirectExecutionStatus(
  write: (tx: DbTransaction) => Promise<DirectExecutionEventRow[]>
): Promise<DirectExecutionEventRow[]> {
  return await db.transaction(async (tx) => {
    const rows = await write(tx);
    if (isOutboundWebhooksEnabled()) {
      for (const row of rows) {
        await recordDirectExecutionEvent(tx, row);
      }
    }
    return rows;
  });
}
