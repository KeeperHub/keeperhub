/**
 * KEEP-1199: one-time backfill of the denormalised `organization_id` column on
 * `workflow_executions`.
 *
 * Migration 0147 adds the column null. New rows are populated at insert by
 * every trigger path (the API execute/webhook/mcp/internal routes and the
 * executor). This script fills historical rows so a run resolves its owning
 * org from itself rather than from a join through `workflows`, which is what
 * getOrganizationIdFromExecution falls back to while rows are still null.
 *
 * Scope: every row where organization_id IS NULL. The value comes from the
 * workflow the run belongs to; `workflows.organization_id` is NOT NULL, so
 * every row resolves and none are skipped.
 *
 * Approach: keyset batches over the null rows, joining `workflows` for the
 * value. COALESCE preserves anything the live writer already set, so there is
 * no clobber race on hot recent rows. Idempotent and resumable via --after-id.
 *
 * A LIVE run against a non-local DB requires --yes; dry-runs and local DBs do
 * not. This is a guard against an accidental prod write, not a security
 * boundary.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-execution-organization-id.ts --dry-run
 *   pnpm tsx scripts/backfill-execution-organization-id.ts                # local DB
 *   pnpm tsx scripts/backfill-execution-organization-id.ts --yes          # staging/prod
 *   pnpm tsx scripts/backfill-execution-organization-id.ts --yes --batch-size 2000 --after-id <id>
 *   pnpm tsx scripts/backfill-execution-organization-id.ts --dry-run --max-batches 5
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";

const DEFAULT_BATCH_SIZE = 1000;
const LOG_PREFIX = "[backfill-execution-organization-id]";

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
        "Usage: pnpm tsx scripts/backfill-execution-organization-id.ts [--dry-run] [--batch-size N] [--after-id ID] [--max-batches N] [--yes]"
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * Keyset page of the execution ids still needing a backfill; the cursor for the
 * next batch is the last id.
 */
async function fetchExecutionIdBatch(
  afterId: string,
  batchSize: number
): Promise<string[]> {
  const rows = await db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      sql`${workflowExecutions.id} > ${afterId} AND ${workflowExecutions.organizationId} IS NULL`
    )
    .orderBy(workflowExecutions.id)
    .limit(batchSize);
  return rows.map((r) => r.id);
}

/**
 * Backfill one keyset batch. Re-selects the same batch inside a CTE
 * (deterministic for a fixed cursor) so no id array has to be marshalled into
 * the statement. COALESCE keeps any value the live writer already set.
 * Returns the number of rows written.
 */
async function applyBatch(afterId: string, batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT we.id, w.organization_id
      FROM workflow_executions we
      JOIN workflows w ON w.id = we.workflow_id
      WHERE we.id > ${afterId}
        AND we.organization_id IS NULL
      ORDER BY we.id
      LIMIT ${batchSize}
    )
    UPDATE workflow_executions
    SET organization_id = COALESCE(
      workflow_executions.organization_id,
      batch.organization_id
    )
    FROM batch
    WHERE workflow_executions.id = batch.id
    RETURNING workflow_executions.id
  `);
  // postgres-js: db.execute resolves to the RETURNING rows array.
  return result.length;
}

/** Dry-run: count how many rows in the batch WOULD be written. */
async function countBatch(afterId: string, batchSize: number): Promise<number> {
  const result = await db.execute(sql`
    WITH batch AS (
      SELECT we.id
      FROM workflow_executions we
      JOIN workflows w ON w.id = we.workflow_id
      WHERE we.id > ${afterId}
        AND we.organization_id IS NULL
      ORDER BY we.id
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
    `${LOG_PREFIX} mode=${args.dryRun ? "DRY-RUN" : "LIVE"} host=${dbHost()} batchSize=${args.batchSize} afterId=${args.afterId || "(start)"} maxBatches=${args.maxBatches ?? "all"}`
  );

  // A LIVE run against a non-local DB (staging/prod) writes immediately. Require
  // an explicit --yes so an operator cannot kick one off by reflex. Dry-runs and
  // local DBs are unguarded.
  if (!(args.dryRun || args.yes || isLocalDb())) {
    console.error(
      `${LOG_PREFIX} refusing LIVE run against non-local host ${dbHost()} without --yes. Re-run with --yes to confirm, or add --dry-run.`
    );
    process.exit(1);
  }

  let cursor = args.afterId;
  let batches = 0;
  let totalScanned = 0;
  let totalWritten = 0;

  for (;;) {
    const ids = await fetchExecutionIdBatch(cursor, args.batchSize);
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
      `${LOG_PREFIX} batch=${batches} scanned=${ids.length} written=${written} cursor=${cursor} cumulative_scanned=${totalScanned} cumulative_written=${totalWritten}`
    );

    if (ids.length < args.batchSize) {
      break;
    }
    if (args.maxBatches !== null && batches >= args.maxBatches) {
      console.log(
        `${LOG_PREFIX} stopping at --max-batches=${args.maxBatches}; resume with --after-id ${cursor}`
      );
      break;
    }
  }

  console.log(
    `${LOG_PREFIX} done. mode=${args.dryRun ? "DRY-RUN" : "LIVE"} batches=${batches} scanned=${totalScanned} written=${totalWritten} last_cursor=${cursor || "(none)"}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG_PREFIX} failed:`, err);
    process.exit(1);
  });
