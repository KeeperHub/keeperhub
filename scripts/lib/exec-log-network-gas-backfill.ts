/**
 * KEEP-857 backfill query logic for the denormalised `network` / `gas_used_wei`
 * columns on `workflow_execution_logs`, extracted from
 * scripts/backfill-exec-log-network-gas.ts so a database-backed test can run a
 * batch directly instead of shelling out to the CLI.
 *
 * The CLI wrapper owns argument parsing, the non-local-write guard and the
 * progress logging; everything that touches SQL lives here.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logInputField, logOutputField } from "@/lib/db/execution-log-fields";
import { workflowExecutionLogs } from "@/lib/db/schema";

export const DEFAULT_BATCH_SIZE = 1000;

const networkExpr = logInputField("network");
const gasExpr = logOutputField("gasUsed");

/**
 * A row still needs denormalising if either column is unset while the JSONB it
 * mirrors carries a value.
 *
 * The gas arm is the original KEEP-857 scope. The network arm was added when
 * fetchWorkflowRuns started reading `network` on rows that spend no gas: a
 * read-only or pre-flight-failed step has a network in `input` and no `gasUsed`
 * in `output`, so the gas arm alone never reaches it. Keeping both arms means a
 * partially-backfilled row (network filled by an earlier run, gas still null, or
 * the reverse) is still picked up.
 */
const needsBackfill = sql`(
  (${workflowExecutionLogs.network} IS NULL AND ${networkExpr} IS NOT NULL)
  OR (${workflowExecutionLogs.gasUsedWei} IS NULL AND ${gasExpr} IS NOT NULL)
)`;

/**
 * Keyset page of the log ids still needing a backfill; the cursor for the next
 * batch is the last id returned.
 */
export async function fetchLogIdBatch(
  afterId: string,
  batchSize: number
): Promise<string[]> {
  const rows = await db
    .select({ id: workflowExecutionLogs.id })
    .from(workflowExecutionLogs)
    .where(sql`${workflowExecutionLogs.id} > ${afterId} AND ${needsBackfill}`)
    .orderBy(workflowExecutionLogs.id)
    .limit(batchSize);
  return rows.map((r) => r.id);
}

/**
 * Backfill one keyset batch. Re-selects the same batch inside a CTE
 * (deterministic for a fixed cursor) so no id array has to be marshalled into
 * the statement. COALESCE keeps any value the live writer already set, so there
 * is no clobber race on hot recent rows and a re-run is a no-op on rows already
 * populated. Returns the number of rows written.
 */
export async function applyBatch(
  afterId: string,
  batchSize: number
): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT id FROM workflow_execution_logs
      WHERE id > ${afterId}
        AND ${needsBackfill}
      ORDER BY id
      LIMIT ${batchSize}
    )
    UPDATE workflow_execution_logs
    SET network = COALESCE(workflow_execution_logs.network, ${networkExpr}),
        gas_used_wei = COALESCE(
          workflow_execution_logs.gas_used_wei,
          CAST(${gasExpr} AS NUMERIC)
        )
    FROM batch
    WHERE workflow_execution_logs.id = batch.id
    RETURNING workflow_execution_logs.id
  `);
  // postgres-js: db.execute resolves to the RETURNING rows array.
  return result.length;
}

/** Dry-run: count how many rows in the batch WOULD be written. */
export async function countBatch(
  afterId: string,
  batchSize: number
): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT id FROM workflow_execution_logs
      WHERE id > ${afterId}
        AND ${needsBackfill}
      ORDER BY id
      LIMIT ${batchSize}
    )
    SELECT COUNT(*) AS n FROM batch
  `);
  // postgres-js: db.execute resolves to the rows array.
  return Number(result[0]?.n ?? 0);
}
