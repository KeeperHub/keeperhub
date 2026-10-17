import "server-only";

import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type DirectExecution,
  directExecutions,
  eventOutbox,
  type NewDirectExecution,
} from "@/lib/db/schema";
import {
  DIRECT_EXECUTION_TERMINAL_STATUSES,
  type DirectExecutionStatus,
  isDirectExecutionTerminalStatus,
} from "@/lib/errors/execution-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  DIRECT_EXECUTION_DEDUPE_KEY_PREFIX,
  DIRECT_EXECUTION_EVENT_TYPE_BY_STATUS,
} from "./event-types";
import { isOutboundWebhooksEnabled } from "./feature-flag";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The columns an event is built from. The status UPDATE hands them back via
// `.returning()`, so building the event needs no second read.
const EVENT_COLUMNS = {
  id: directExecutions.id,
  organizationId: directExecutions.organizationId,
  type: directExecutions.type,
  status: directExecutions.status,
  network: directExecutions.network,
  transactionHash: directExecutions.transactionHash,
  error: directExecutions.error,
  completedAt: directExecutions.completedAt,
};

export type DirectExecutionEventRow = Pick<
  DirectExecution,
  keyof typeof EVENT_COLUMNS
>;

export type DirectExecutionStatusPatch = Omit<
  Partial<NewDirectExecution>,
  "id" | "status"
> & { status: DirectExecutionStatus };

type StatusWriteOptions = {
  // Statuses the row must currently be in for the write to apply. Defaults to
  // every non-final status, so a final status is never overwritten.
  from?: readonly DirectExecutionStatus[];
};

// Longest error message an event carries, in UTF-8 bytes.
const MAX_EVENT_ERROR_BYTES = 1024;
const CONTROL_CHARACTERS = /\p{Cc}+/gu;

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) {
    return text;
  }
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) {
      break;
    }
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The error message as an event carries it: control characters replaced with a
 * space, so the words either side of a stripped newline stay apart, and cut to
 * 1 KiB without splitting a character.
 */
export function sanitizeEventError(error: string | null): string | null {
  if (error === null) {
    return null;
  }
  const stripped = error.replace(CONTROL_CHARACTERS, " ").trim();
  return truncateUtf8(stripped, MAX_EVENT_ERROR_BYTES);
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
    error: sanitizeEventError(row.error),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function recordEvent(
  tx: DbTransaction,
  row: DirectExecutionEventRow
): Promise<void> {
  if (!isDirectExecutionTerminalStatus(row.status)) {
    return;
  }
  const eventType = DIRECT_EXECUTION_EVENT_TYPE_BY_STATUS[row.status];
  try {
    // Inside a savepoint, so a failed insert rolls back only itself and the
    // status write it belongs to still commits.
    await tx.transaction(async (savepoint) => {
      await savepoint
        .insert(eventOutbox)
        .values({
          organizationId: row.organizationId,
          eventType,
          executionId: row.id,
          dedupeKey: `${DIRECT_EXECUTION_DEDUPE_KEY_PREFIX}${row.id}`,
          data: eventData(row),
        })
        .onConflictDoNothing({ target: eventOutbox.dedupeKey });
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[OutboundWebhook] Failed to record a direct-execution event; the status write still commits",
      error,
      { execution_id: row.id, event_type: eventType }
    );
  }
}

/**
 * The single writer of `direct_executions.status`. Applies `patch` to the
 * execution and returns the updated row, or null when the row was not in a
 * status the guard allows.
 *
 * A final status is never overwritten, so the first final write is the only
 * one and its event always matches the row. When that write is final and
 * outbound webhooks are enabled, the event goes into `event_outbox` in the same
 * transaction, behind a savepoint so an outbox failure can never undo the
 * status. Every other write is a single UPDATE with no transaction.
 */
export async function setDirectExecutionStatus(
  executionId: string,
  patch: DirectExecutionStatusPatch,
  options: StatusWriteOptions = {}
): Promise<DirectExecutionEventRow | null> {
  const guard = options.from
    ? inArray(directExecutions.status, [...options.from])
    : notInArray(directExecutions.status, [
        ...DIRECT_EXECUTION_TERMINAL_STATUSES,
      ]);
  const update = (executor: Pick<DbTransaction, "update">) =>
    executor
      .update(directExecutions)
      .set(patch)
      .where(and(eq(directExecutions.id, executionId), guard))
      .returning(EVENT_COLUMNS);

  const emits =
    isOutboundWebhooksEnabled() &&
    isDirectExecutionTerminalStatus(patch.status);
  if (!emits) {
    const [row] = await update(db);
    return row ?? null;
  }

  return await db.transaction(async (tx) => {
    const [row] = await update(tx);
    if (row) {
      await recordEvent(tx, row);
    }
    return row ?? null;
  });
}
