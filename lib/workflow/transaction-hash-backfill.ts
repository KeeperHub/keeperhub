import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { TransactionHashEntry } from "@/lib/db/schema";
import { isRecordableTransactionHash } from "@/lib/workflow/executor/step-success-tracker";

/**
 * One-time backfill of `workflow_executions.transaction_hashes` for successful
 * runs whose array is still empty, rebuilt from the step logs before retention
 * removes them. The analytics network filter and its facet counts read this
 * array once a run's step logs are gone, and unlike gas there is no second
 * source to fall back on.
 *
 * It reads `output`, not `output_raw`. Retention nulls `output_raw` after seven
 * days, and rows written before that column existed never had it. The keys read
 * here (transactionHash, chainId, network) are not redacted (lib/utils/redact.ts),
 * so `output` carries the same values.
 *
 * It mirrors loadHashesFromLogs and toHashEntry (lib/workflow/executor/logging.ts):
 * success steps only, ordered by started_at, deduplicated by hash, the same
 * shape check, chainId kept only when it is a number and network only when it
 * is a string. A backfilled array and a freshly written one cannot drift.
 *
 * Successful runs only. That is the one finalize that resolves hashes this way.
 * A run finalizing as a failure is recorded by loadFailureBroadcasts, which also
 * takes the failed steps and checks in-flight hashes on chain, and a
 * success-steps-only array on a failed run would be exactly the
 * plausible-looking partial record that path exists to avoid.
 *
 * A batch is a set of whole runs, never a slice of step rows: an array is never
 * rewritten once it is non-empty, so a run written with part of its steps would
 * stay that way. Candidates come from gas-bearing step logs, so the scan never
 * de-TOASTs the whole log table; the per-run read is keyed on execution_id.
 *
 * Idempotent: the UPDATE only touches an array that is still empty, so a
 * re-run resumes where the last one stopped and a concurrent finalize wins.
 */

type HashStepRow = {
  execution_id: string;
  node_id: string;
  node_name: string;
  iteration_index: number | null;
  transaction_hash: unknown;
  chain_id: unknown;
  network: unknown;
};

export type BackfillProgress = {
  batch: number;
  runs: number;
  hashes: number;
  cursor: string;
};

export type BackfillOptions = {
  dryRun: boolean;
  /** Runs per batch, not step rows, so no run is ever split across batches. */
  batchSize: number;
  maxBatches?: number;
  onBatch?: (progress: BackfillProgress) => void;
};

export type BackfillResult = {
  batches: number;
  /** Runs written, or in a dry run the runs that would be. */
  runs: number;
  hashes: number;
};

/** The next page of successful runs that have an empty array and a hash to recover. */
async function nextCandidates(
  afterId: string,
  limit: number
): Promise<string[]> {
  const rows = await db.execute<{ execution_id: string }>(sql`
    SELECT DISTINCT l.execution_id
      FROM workflow_execution_logs l
      JOIN workflow_executions e ON e.id = l.execution_id
     WHERE l.gas_used_wei > 0
       AND l.status = 'success'
       AND l.output->>'transactionHash' IS NOT NULL
       AND e.status = 'success'
       AND jsonb_array_length(e.transaction_hashes) = 0
       AND l.execution_id > ${afterId}
     ORDER BY l.execution_id
     LIMIT ${limit}
  `);
  return rows.map((row) => row.execution_id);
}

/** Every hash-bearing success step of these runs, in the order the writer reads them. */
async function hashSteps(executionIds: string[]): Promise<HashStepRow[]> {
  const ids = sql.join(
    executionIds.map((id) => sql`${id}`),
    sql`, `
  );
  const rows = await db.execute<HashStepRow>(sql`
    SELECT l.execution_id,
           l.node_id,
           l.node_name,
           l.iteration_index,
           l.output->'transactionHash' AS transaction_hash,
           l.output->'chainId'         AS chain_id,
           l.output->'network'         AS network
      FROM workflow_execution_logs l
     WHERE l.execution_id IN (${ids})
       AND l.status = 'success'
       AND l.output->>'transactionHash' IS NOT NULL
     ORDER BY l.execution_id, l.started_at
  `);
  return [...rows];
}

/** toHashEntry, read from `output`. */
function toEntry(row: HashStepRow): TransactionHashEntry | null {
  const hash = row.transaction_hash;
  if (
    typeof hash !== "string" ||
    !isRecordableTransactionHash(hash, row.chain_id)
  ) {
    return null;
  }
  return {
    hash,
    nodeId: row.node_id,
    nodeName: row.node_name,
    ...(typeof row.chain_id === "number" && { chainId: row.chain_id }),
    ...(typeof row.network === "string" && { network: row.network }),
    ...(row.iteration_index !== null && {
      iterationIndex: row.iteration_index,
    }),
  };
}

/** Per run, deduplicated by hash the way loadHashesFromLogs does it. */
function groupByRun(rows: HashStepRow[]): Map<string, TransactionHashEntry[]> {
  const byRun = new Map<string, TransactionHashEntry[]>();
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const entry = toEntry(row);
    if (!entry) {
      continue;
    }
    const runSeen = seen.get(row.execution_id) ?? new Set<string>();
    if (runSeen.has(entry.hash)) {
      continue;
    }
    runSeen.add(entry.hash);
    seen.set(row.execution_id, runSeen);
    const entries = byRun.get(row.execution_id) ?? [];
    entries.push(entry);
    byRun.set(row.execution_id, entries);
  }
  return byRun;
}

export async function backfillTransactionHashes(
  options: BackfillOptions
): Promise<BackfillResult> {
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const result: BackfillResult = { batches: 0, runs: 0, hashes: 0 };
  let cursor = "";

  while (result.batches < maxBatches) {
    const executionIds = await nextCandidates(cursor, options.batchSize);
    if (executionIds.length === 0) {
      break;
    }
    cursor = executionIds.at(-1) ?? cursor;
    result.batches += 1;

    let runs = 0;
    let hashes = 0;
    for (const [executionId, entries] of groupByRun(
      await hashSteps(executionIds)
    )) {
      if (!options.dryRun) {
        // Still gated on an empty array, so a concurrent finalize wins over
        // the backfill rather than being overwritten by it.
        const updated = await db.execute(sql`
          UPDATE workflow_executions
             SET transaction_hashes = ${JSON.stringify(entries)}::jsonb
           WHERE id = ${executionId}
             AND jsonb_array_length(transaction_hashes) = 0
        `);
        if (updated.count === 0) {
          continue;
        }
      }
      runs += 1;
      hashes += entries.length;
    }

    result.runs += runs;
    result.hashes += hashes;
    options.onBatch?.({ batch: result.batches, runs, hashes, cursor });
  }
  return result;
}
