/**
 * One-time backfill of `workflow_executions.transaction_hashes` for successful
 * runs whose array is still empty, rebuilt from the step logs before retention
 * removes them. What it reads, and why, is documented on
 * lib/workflow/transaction-hash-backfill.ts.
 *
 * A live run against a non-local database needs a terminal and the database
 * host typed back before the first write. Dry runs and local databases do not.
 * A flag can be passed by a script that did not mean to; a typed host cannot.
 * This guards against an accidental prod write, it is not a security boundary.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-workflow-transaction-hashes.ts --dry-run
 *   pnpm tsx scripts/backfill-workflow-transaction-hashes.ts
 *   pnpm tsx scripts/backfill-workflow-transaction-hashes.ts --batch-size 200 --max-batches 5
 */

import { createInterface } from "node:readline/promises";
import { backfillTransactionHashes } from "@/lib/workflow/transaction-hash-backfill";

const DEFAULT_BATCH_SIZE = 500;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "postgres", "db"];

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  return {
    dryRun: argv.includes("--dry-run"),
    batchSize: Number(value("--batch-size") ?? DEFAULT_BATCH_SIZE),
    maxBatches: Number(value("--max-batches") ?? Number.POSITIVE_INFINITY),
  };
}

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "";
  }
}

/** Ask for the host back on a terminal. Anything else, no terminal included, is a no. */
async function confirmLiveWrite(host: string): Promise<boolean> {
  if (!(host && process.stdin.isTTY)) {
    return false;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      `This writes transaction_hashes on ${host}. Type the host to continue: `
    );
    return answer.trim() === host;
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  const { dryRun, batchSize, maxBatches } = parseArgs();

  if (!(Number.isInteger(batchSize) && batchSize > 0)) {
    process.stdout.write("--batch-size must be a positive integer.\n");
    process.exit(1);
  }
  if (!(maxBatches > 0)) {
    process.stdout.write("--max-batches must be a positive number.\n");
    process.exit(1);
  }

  const host = databaseHost();
  if (!(dryRun || LOCAL_HOSTS.includes(host))) {
    const confirmed = await confirmLiveWrite(host);
    if (!confirmed) {
      process.stdout.write(
        "Not confirmed, nothing was written. A live run against a non-local database needs a terminal and the host typed back. --dry-run shows what would change.\n"
      );
      process.exit(1);
    }
  }

  const result = await backfillTransactionHashes({
    dryRun,
    batchSize,
    maxBatches,
    onBatch: (progress) => {
      process.stdout.write(
        `batch ${progress.batch}: ${progress.runs} runs, ${progress.hashes} hashes, cursor ${progress.cursor}\n`
      );
    },
  });

  process.stdout.write(
    `${dryRun ? "[dry run] would update" : "updated"} ${result.runs} runs with ${result.hashes} hashes across ${result.batches} batches\n`
  );
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
