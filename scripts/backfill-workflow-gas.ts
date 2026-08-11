/**
 * KEEP-683: one-time backfill of the denormalised `gas_used_wei` column on
 * `workflow_executions`.
 *
 * Migration 0096 adds the column null. New rows are populated at finalize by
 * lib/workflow/executor/logging.ts. This script fills historical rows so the
 * /analytics reads can move off the per-row logs JSONB scan (PR2) without the
 * totals changing.
 *
 * Approach: set-based, one aggregating UPDATE per keyset batch of execution ids
 * (NOT one query per row - this runs over millions of rows on prod). Each batch
 * sums the gas-bearing logs for its executions via idx_exec_logs_execution_id
 * and writes the run-total. Executions with no gas-bearing step are left null.
 *
 * Status-agnostic on purpose: a gas-bearing step (e.g. an approve) can commit
 * its gas before a later step fails the run, and the current /analytics gas
 * total counts that gas regardless of run status. Scoping to success would make
 * the backfilled column disagree with today's dashboard.
 *
 * The extraction uses the shared logOutputField builder, the same one the
 * executor writer and the /analytics reads use, so all three agree
 * value-for-value.
 *
 * Idempotent and resumable: re-running recomputes deterministically; pass
 * --after-id to resume from a known cursor. The heavy JSONB scan is paid once,
 * in controlled batches, so no single UPDATE takes a long lock.
 *
 * A LIVE run against a non-local DB requires --yes; dry-runs and local DBs do
 * not. This is a guard against an accidental prod write, not a security
 * boundary.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-workflow-gas.ts --dry-run
 *   pnpm tsx scripts/backfill-workflow-gas.ts                       # local DB
 *   pnpm tsx scripts/backfill-workflow-gas.ts --yes                 # staging/prod
 *   pnpm tsx scripts/backfill-workflow-gas.ts --yes --batch-size 2000 --after-id <id>
 *   pnpm tsx scripts/backfill-workflow-gas.ts --dry-run --max-batches 5
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logOutputField } from "@/lib/db/execution-log-fields";
import { workflowExecutions } from "@/lib/db/schema";

const DEFAULT_BATCH_SIZE = 1000;

type CliArgs = {
  dryRun: boolean;
  batchSize: number;
  afterId: string;
  maxBatches: number | null;
  yes: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    afterId: "",
    maxBatches: null,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--yes") {
      args.yes = true;
    } else if (a === "--batch-size" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.batchSize = parsed;
      }
      i++;
    } else if (a === "--after-id" && argv[i + 1]) {
      args.afterId = argv[i + 1];
      i++;
    } else if (a === "--max-batches" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.maxBatches = parsed;
      }
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: pnpm tsx scripts/backfill-workflow-gas.ts [--dry-run] [--batch-size N] [--after-id ID] [--max-batches N] [--yes]"
      );
      process.exit(0);
    }
  }
  return args;
}

/** Keyset page of execution ids; the cursor for the next batch is the last id. */
async function fetchExecutionIdBatch(
  afterId: string,
  batchSize: number
): Promise<string[]> {
  const rows = await db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(sql`${workflowExecutions.id} > ${afterId}`)
    .orderBy(workflowExecutions.id)
    .limit(batchSize);
  return rows.map((r) => r.id);
}

/**
 * Aggregate gas for one keyset batch and write it. Re-selects the same
 * batch inside a CTE (deterministic for a fixed cursor) so no id array has to be
 * marshalled into the statement. Returns the number of executions updated (i.e.
 * those that had at least one gas-bearing log and were not already populated).
 *
 * The `we.gas_used_wei IS NULL` guard means the backfill only ever fills empty
 * rows, never overwrites a value. That keeps it off the hot recent rows the
 * live finalize writer owns (no clobber race), makes re-runs cheap, and avoids
 * redundant write churn on the multi-GB table.
 */
async function applyBatch(afterId: string, batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT id FROM workflow_executions
      WHERE id > ${afterId}
      ORDER BY id
      LIMIT ${batchSize}
    ), agg AS (
      SELECT
        workflow_execution_logs.execution_id AS execution_id,
        SUM(CAST(${logOutputField("gasUsed")} AS NUMERIC)) AS gas_used_wei
      FROM workflow_execution_logs
      JOIN batch ON batch.id = workflow_execution_logs.execution_id
      WHERE ${logOutputField("gasUsed")} IS NOT NULL
      GROUP BY workflow_execution_logs.execution_id
    )
    UPDATE workflow_executions we
    SET gas_used_wei = agg.gas_used_wei
    FROM agg
    WHERE we.id = agg.execution_id
      AND we.gas_used_wei IS NULL
    RETURNING we.id
  `);
  // postgres-js: db.execute resolves to the RETURNING rows array.
  return result.length;
}

/** Dry-run: count how many executions in the batch WOULD be updated. */
async function countBatch(afterId: string, batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT id, gas_used_wei FROM workflow_executions
      WHERE id > ${afterId}
      ORDER BY id
      LIMIT ${batchSize}
    )
    SELECT COUNT(DISTINCT workflow_execution_logs.execution_id) AS n
    FROM workflow_execution_logs
    JOIN batch ON batch.id = workflow_execution_logs.execution_id
    WHERE ${logOutputField("gasUsed")} IS NOT NULL
      AND batch.gas_used_wei IS NULL
  `);
  // postgres-js: db.execute resolves to the rows array.
  return Number(result[0]?.n ?? 0);
}

function dbHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unknown)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db", "postgres"]);

function isLocalDb(): boolean {
  try {
    // URL.hostname drops the port; strip the IPv6 brackets it keeps.
    const hostname = new URL(process.env.DATABASE_URL ?? "").hostname.replace(
      /^\[|\]$/g,
      ""
    );
    return LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-workflow-gas] mode=${args.dryRun ? "DRY-RUN" : "LIVE"} host=${dbHost()} batchSize=${args.batchSize} afterId=${args.afterId || "(start)"} maxBatches=${args.maxBatches ?? "all"}`
  );

  // A LIVE run against a non-local DB (staging/prod) writes immediately. Require
  // an explicit --yes so an operator cannot kick one off by reflex. Dry-runs and
  // local DBs are unguarded.
  if (!(args.dryRun || args.yes || isLocalDb())) {
    console.error(
      `[backfill-workflow-gas] refusing LIVE run against non-local host ${dbHost()} without --yes. Re-run with --yes to confirm, or add --dry-run.`
    );
    process.exit(1);
  }

  let cursor = args.afterId;
  let batches = 0;
  let totalScanned = 0;
  let totalUpdated = 0;

  for (;;) {
    const ids = await fetchExecutionIdBatch(cursor, args.batchSize);
    if (ids.length === 0) {
      break;
    }

    const updated = args.dryRun
      ? await countBatch(cursor, args.batchSize)
      : await applyBatch(cursor, args.batchSize);

    batches += 1;
    totalScanned += ids.length;
    totalUpdated += updated;
    cursor = ids[ids.length - 1];

    console.log(
      `[backfill-workflow-gas] batch=${batches} scanned=${ids.length} updated=${updated} cursor=${cursor} cumulative_scanned=${totalScanned} cumulative_updated=${totalUpdated}`
    );

    if (ids.length < args.batchSize) {
      break;
    }
    if (args.maxBatches !== null && batches >= args.maxBatches) {
      console.log(
        `[backfill-workflow-gas] stopping at --max-batches=${args.maxBatches}; resume with --after-id ${cursor}`
      );
      break;
    }
  }

  console.log(
    `[backfill-workflow-gas] done. mode=${args.dryRun ? "DRY-RUN" : "LIVE"} batches=${batches} scanned=${totalScanned} updated=${totalUpdated} last_cursor=${cursor || "(none)"}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-workflow-gas] failed:", err);
    process.exit(1);
  });
