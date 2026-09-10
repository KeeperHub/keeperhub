/**
 * KEEP-1042: one-time backfill of `workflow_executions.transaction_hashes`
 * from the step logs, before retention removes the rows it derives from.
 *
 * Migration 0071 added the column with a `[]` default and no backfill, on the
 * stated assumption that history was "reconstructable on demand from
 * workflow_execution_logs.output_raw if backfill is ever needed". Two things
 * make that assumption unsafe now:
 *
 *   1. The retention job nulls `output_raw` at a flat seven days for every
 *      plan, so the source that comment points at is the first thing to go.
 *      Measured on prod: of the gas-bearing step logs behind runs with an
 *      empty array, `output` carries the hash on all 11,186 and `output_raw`
 *      on roughly a fifth. `transactionHash` is not a redacted key, so the two
 *      columns agree wherever both are present -- `output` is simply the
 *      column that survives.
 *   2. The array is only written at a SUCCESSFUL finalize
 *      (resolveTransactionHashesForSuccess), so a run that spent gas and then
 *      failed never gets one at all. That is a live gap, not a historical one:
 *      the newest affected run on prod is from today.
 *
 * The column matters more than it used to because the analytics network filter
 * and its facet counts now read it as the retention-proof source of which
 * chains a run touched. A run with an empty array drops out of a network
 * filter once its step logs are purged, and unlike the gas column there is no
 * second source to fall back on.
 *
 * Approach: keyset batches over the affected executions, anchored on
 * idx_exec_logs_gas_started_at so the candidate scan never de-TOASTs the whole
 * log table -- an unanchored `output->>'transactionHash' IS NOT NULL` over
 * 23M rows is the exact shape that saturated prod CPU on 2026-09-02.
 *
 * Mirrors loadHashesFromLogs (lib/workflow/executor/logging.ts): success steps
 * only, ordered by started_at, deduplicated by hash, and filtered through the
 * same shape check the in-memory tracker uses, so a backfilled array and a
 * freshly written one cannot drift.
 *
 * Idempotent: it only ever touches rows whose array is still empty, so a
 * re-run after a partial pass resumes rather than duplicating.
 *
 * A LIVE run against a non-local DB requires --yes; dry-runs and local DBs do
 * not. This is a guard against an accidental prod write, not a security
 * boundary.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-workflow-transaction-hashes.ts --dry-run
 *   pnpm tsx scripts/backfill-workflow-transaction-hashes.ts --yes
 *   pnpm tsx scripts/backfill-workflow-transaction-hashes.ts --yes --batch-size 500
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isRecordableTransactionHash } from "@/lib/workflow/executor/step-success-tracker";

const DEFAULT_BATCH_SIZE = 500;

type CandidateRow = {
  execution_id: string;
  node_id: string;
  node_name: string;
  iteration_index: number | null;
  hash: string;
  chain_id: unknown;
  network: string | null;
};

type HashEntry = {
  hash: string;
  nodeId: string;
  nodeName: string;
  chainId?: number;
  network?: string;
  iterationIndex?: number;
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  return {
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
    batchSize: Number(value("--batch-size") ?? DEFAULT_BATCH_SIZE),
    maxBatches: Number(value("--max-batches") ?? Number.POSITIVE_INFINITY),
  };
}

function isLocalDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return ["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host);
  } catch {
    return false;
  }
}

/**
 * The hash-bearing success steps of executions whose array is still empty,
 * after `afterId`. Anchored on gas_used_wei so the planner drives from
 * idx_exec_logs_gas_started_at rather than scanning the log table's JSONB.
 */
async function fetchCandidates(
  afterId: string,
  limit: number
): Promise<CandidateRow[]> {
  const rows = await db.execute<CandidateRow>(sql`
    SELECT l.execution_id,
           l.node_id,
           l.node_name,
           l.iteration_index,
           l.output->>'transactionHash' AS hash,
           l.output->'chainId'          AS chain_id,
           l.output->>'network'         AS network
      FROM workflow_execution_logs l
      JOIN workflow_executions e ON e.id = l.execution_id
     WHERE l.gas_used_wei > 0
       AND l.status = 'success'
       AND l.output->>'transactionHash' IS NOT NULL
       AND jsonb_array_length(e.transaction_hashes) = 0
       AND l.execution_id > ${afterId}
     ORDER BY l.execution_id, l.started_at
     LIMIT ${limit}
  `);
  return [...rows];
}

/** Group the flat rows per execution, deduplicating exactly as the writer does. */
function groupEntries(rows: CandidateRow[]): Map<string, HashEntry[]> {
  const byExecution = new Map<string, HashEntry[]>();
  const seen = new Map<string, Set<string>>();

  for (const row of rows) {
    const chainId =
      typeof row.chain_id === "number" ? row.chain_id : Number(row.chain_id);
    const validChainId = Number.isFinite(chainId) ? chainId : undefined;
    if (!isRecordableTransactionHash(row.hash, validChainId)) {
      continue;
    }
    const already = seen.get(row.execution_id) ?? new Set<string>();
    if (already.has(row.hash)) {
      continue;
    }
    already.add(row.hash);
    seen.set(row.execution_id, already);

    const entries = byExecution.get(row.execution_id) ?? [];
    entries.push({
      hash: row.hash,
      nodeId: row.node_id,
      nodeName: row.node_name,
      ...(validChainId !== undefined && { chainId: validChainId }),
      ...(row.network !== null && { network: row.network }),
      ...(row.iteration_index !== null && {
        iterationIndex: row.iteration_index,
      }),
    });
    byExecution.set(row.execution_id, entries);
  }
  return byExecution;
}

async function main(): Promise<void> {
  const { dryRun, yes, batchSize, maxBatches } = parseArgs();

  if (!(dryRun || yes || isLocalDatabase())) {
    process.stdout.write(
      "Refusing to write to a non-local database without --yes.\n"
    );
    process.exit(1);
  }

  let afterId = "";
  let batches = 0;
  let runsUpdated = 0;
  let hashesWritten = 0;

  for (;;) {
    if (batches >= maxBatches) {
      break;
    }
    const rows = await fetchCandidates(afterId, batchSize);
    if (rows.length === 0) {
      break;
    }
    batches += 1;
    afterId = rows.at(-1)?.execution_id ?? afterId;

    const grouped = groupEntries(rows);
    for (const [executionId, entries] of grouped) {
      hashesWritten += entries.length;
      runsUpdated += 1;
      if (dryRun) {
        continue;
      }
      // Still gated on an empty array, so a concurrent finalize wins over the
      // backfill rather than being overwritten by it.
      await db.execute(sql`
        UPDATE workflow_executions
           SET transaction_hashes = ${JSON.stringify(entries)}::jsonb
         WHERE id = ${executionId}
           AND jsonb_array_length(transaction_hashes) = 0
      `);
    }
    process.stdout.write(
      `batch ${batches}: ${grouped.size} runs, ${rows.length} steps, cursor ${afterId}\n`
    );
  }

  process.stdout.write(
    `${dryRun ? "[dry run] would update" : "updated"} ${runsUpdated} runs with ${hashesWritten} hashes across ${batches} batches\n`
  );
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
