/**
 * KEEP-857: one-time backfill of the denormalised `network` / `gas_used_wei`
 * columns on `workflow_execution_logs`.
 *
 * Migration 0117 adds the columns null. New rows are populated at write time by
 * lib/workflow/executor/logging.ts (network at step start, gas_used_wei at step
 * complete). This script fills historical rows so the /analytics read paths can
 * move off the per-row input/output JSONB re-parse (the cost behind the
 * networks-endpoint 524) without any total or attribution changing.
 *
 * Scope: every row whose JSONB carries a value the matching column does not.
 * That is wider than the original KEEP-857 scope, which took gas-bearing rows
 * only on the reasoning that nothing read `network` on a gas-free row. That is
 * no longer true - fetchWorkflowRuns reads `network` per step so a run that
 * failed before broadcast keeps its chain (#2093), and a pre-flight failure is
 * exactly a row with a network in `input` and no `gasUsed` in `output`. Gas
 * steps are a small fraction of the table but network-bearing steps are not, so
 * this walk is over most web3 step rows rather than a handful; it is keyset
 * batched, idempotent and resumable via --after-id, so a long run is fine to
 * interrupt and continue.
 *
 * Correctness does not depend on this having run. lib/analytics/queries.ts reads
 * COALESCE(column, JSONB extract), so an unbackfilled row still resolves; the
 * backfill is what retires the JSONB arm, not what makes it right.
 *
 * Approach: keyset batches, each re-extracting network/gasUsed from the JSONB
 * via the shared logInputField/logOutputField builders - the same expressions
 * the executor writer mirrors in JS and the /analytics reads use as their
 * fallback arm, so all paths agree value-for-value. COALESCE preserves any value
 * the live writer already set (no clobber race on hot recent rows).
 *
 * The SQL lives in scripts/lib/exec-log-network-gas-backfill.ts so
 * tests/e2e/vitest/analytics-run-network.db.test.ts can run a batch directly.
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

import {
  applyBatch,
  countBatch,
  DEFAULT_BATCH_SIZE,
  fetchLogIdBatch,
} from "@/scripts/lib/exec-log-network-gas-backfill";

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
