/**
 * KEEP-857: one-time backfill of the denormalised `network` / `gas_used_wei`
 * columns on `workflow_execution_logs`.
 *
 * Migration 0117 adds the columns null. New rows are populated at write time by
 * lib/workflow/executor/logging.ts (network at step start, gas_used_wei at step
 * complete). This script fills historical rows so the /analytics per-network
 * gas breakdown can move off the per-row input/output JSONB re-parse (the cost
 * behind the networks-endpoint 524) without the breakdown totals changing.
 *
 * Scope: only gas-bearing rows. The per-network breakdown reads network and
 * gas_used_wei exclusively for rows where gas_used_wei IS NOT NULL, so those are
 * the only historical rows that need denormalising. Gas steps are a tiny
 * fraction of the table (most rows are reads with no on-chain gas), so this
 * touches a handful of rows rather than the whole multi-GB table. network on
 * non-gas rows stays null on purpose; nothing reads it.
 *
 * Approach: keyset batches over the gas-bearing rows, each re-extracting
 * network/gasUsed from the JSONB via the shared logInputField/logOutputField
 * builders, the same expressions the executor writer mirrors in JS and the
 * /analytics reads used to use, so all paths agree value-for-value. COALESCE
 * preserves any value the live writer already set (no clobber race on hot
 * recent rows). Idempotent and resumable via --after-id.
 *
 * A LIVE run against a non-local DB requires --yes; dry-runs and local DBs do
 * not. This is a guard against an accidental prod write, not a security
 * boundary.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-exec-log-network-gas.ts --dry-run
 *   pnpm tsx scripts/backfill-exec-log-network-gas.ts                # local DB
 *   pnpm tsx scripts/backfill-exec-log-network-gas.ts --yes          # staging/prod
 *   pnpm tsx scripts/backfill-exec-log-network-gas.ts --yes --batch-size 2000 --after-id <id>
 *   pnpm tsx scripts/backfill-exec-log-network-gas.ts --dry-run --max-batches 5
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  logInputField,
  logOutputField,
} from "@/lib/db/execution-log-fields";
import { workflowExecutionLogs } from "@/lib/db/schema";

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
        "Usage: pnpm tsx scripts/backfill-exec-log-network-gas.ts [--dry-run] [--batch-size N] [--after-id ID] [--max-batches N] [--yes]"
      );
      process.exit(0);
    }
  }
  return args;
}

const networkExpr = logInputField("network");
const gasExpr = logOutputField("gasUsed");

/**
 * Keyset page of the gas-bearing log ids still needing a backfill; the cursor
 * for the next batch is the last id. Filtering to gas rows here keeps the walk
 * over the handful of rows that matter instead of the whole table.
 */
async function fetchLogIdBatch(
  afterId: string,
  batchSize: number
): Promise<string[]> {
  const rows = await db
    .select({ id: workflowExecutionLogs.id })
    .from(workflowExecutionLogs)
    .where(
      sql`${workflowExecutionLogs.id} > ${afterId} AND ${workflowExecutionLogs.gasUsedWei} IS NULL AND ${gasExpr} IS NOT NULL`
    )
    .orderBy(workflowExecutionLogs.id)
    .limit(batchSize);
  return rows.map((r) => r.id);
}

/**
 * Backfill one keyset batch of gas-bearing rows. Re-selects the same batch
 * inside a CTE (deterministic for a fixed cursor) so no id array has to be
 * marshalled into the statement. COALESCE keeps any value the live writer
 * already set; re-runs skip rows whose gas_used_wei is already populated.
 * Returns the number of rows written.
 */
async function applyBatch(afterId: string, batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT id FROM workflow_execution_logs
      WHERE id > ${afterId}
        AND gas_used_wei IS NULL
        AND ${gasExpr} IS NOT NULL
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

/** Dry-run: count how many gas-bearing rows in the batch WOULD be written. */
async function countBatch(afterId: string, batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT id FROM workflow_execution_logs
      WHERE id > ${afterId}
        AND gas_used_wei IS NULL
        AND ${gasExpr} IS NOT NULL
      ORDER BY id
      LIMIT ${batchSize}
    )
    SELECT COUNT(*) AS n FROM batch
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
    `[backfill-exec-log-network-gas] mode=${args.dryRun ? "DRY-RUN" : "LIVE"} host=${dbHost()} batchSize=${args.batchSize} afterId=${args.afterId || "(start)"} maxBatches=${args.maxBatches ?? "all"}`
  );

  // A LIVE run against a non-local DB (staging/prod) writes immediately. Require
  // an explicit --yes so an operator cannot kick one off by reflex. Dry-runs and
  // local DBs are unguarded.
  if (!(args.dryRun || args.yes || isLocalDb())) {
    console.error(
      `[backfill-exec-log-network-gas] refusing LIVE run against non-local host ${dbHost()} without --yes. Re-run with --yes to confirm, or add --dry-run.`
    );
    process.exit(1);
  }

  let cursor = args.afterId;
  let batches = 0;
  let totalScanned = 0;
  let totalWritten = 0;

  for (;;) {
    const ids = await fetchLogIdBatch(cursor, args.batchSize);
    if (ids.length === 0) {
      break;
    }

    const written = args.dryRun
      ? await countBatch(cursor, args.batchSize)
      : await applyBatch(cursor, args.batchSize);

    batches += 1;
    totalScanned += ids.length;
    totalWritten += written;
    cursor = ids[ids.length - 1];

    console.log(
      `[backfill-exec-log-network-gas] batch=${batches} scanned=${ids.length} written=${written} cursor=${cursor} cumulative_scanned=${totalScanned} cumulative_written=${totalWritten}`
    );

    if (ids.length < args.batchSize) {
      break;
    }
    if (args.maxBatches !== null && batches >= args.maxBatches) {
      console.log(
        `[backfill-exec-log-network-gas] stopping at --max-batches=${args.maxBatches}; resume with --after-id ${cursor}`
      );
      break;
    }
  }

  console.log(
    `[backfill-exec-log-network-gas] done. mode=${args.dryRun ? "DRY-RUN" : "LIVE"} batches=${batches} scanned=${totalScanned} written=${totalWritten} last_cursor=${cursor || "(none)"}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-exec-log-network-gas] failed:", err);
    process.exit(1);
  });
