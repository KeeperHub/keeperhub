/**
 * One-time repair of `execution_usage_periods` rows the calendar-month close
 * wrote across billed provider cycles.
 *
 * The close used to be unaware of any cycle held only in
 * `overage_billing_records`, so it wrote whole-month `calendar_month` rows
 * across it: the paid limit, an overage count for executions already invoiced,
 * and a charge of zero. This script records each such cycle as a
 * `subscription` row, then deletes every `calendar_month` row that overlaps a
 * record and writes back the part of it no cycle covers. See
 * `repairCalendarRowsOverBilledCycles` for the rules.
 *
 * Run it AFTER the fixed close is serving in the target environment. An older
 * close does not read overage records and would write the same rows again.
 *
 * Idempotent: a second run reports nothing to do.
 *
 * A LIVE run against a non-local DB requires --yes; dry-runs and local DBs do
 * not. This is a guard against an accidental prod write, not a security
 * boundary.
 *
 * `--conditions=react-server` is required: the billing modules this reuses are
 * marked `server-only`, whose default entry throws outside a server component.
 *
 * Usage:
 *   pnpm tsx --conditions=react-server scripts/repair-calendar-usage-over-billed-cycles.ts --dry-run
 *   pnpm tsx --conditions=react-server scripts/repair-calendar-usage-over-billed-cycles.ts             # local DB
 *   pnpm tsx --conditions=react-server scripts/repair-calendar-usage-over-billed-cycles.ts --yes       # staging/prod
 *   pnpm tsx --conditions=react-server scripts/repair-calendar-usage-over-billed-cycles.ts --yes --org <id>
 */

import "dotenv/config";
import { repairCalendarRowsOverBilledCycles } from "@/lib/billing/execution-usage-period-repair";
import type { PeriodWindow } from "@/lib/billing/execution-usage-periods";
import { isLocalDb } from "@/scripts/lib/local-db";

const LOG_PREFIX = "[repair-calendar-usage-over-billed-cycles]";

type CliArgs = {
  dryRun: boolean;
  yes: boolean;
  org: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, yes: false, org: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--yes") {
      args.yes = true;
    } else if (a === "--org" && argv[i + 1]) {
      args.org = argv[i + 1];
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: pnpm tsx --conditions=react-server scripts/repair-calendar-usage-over-billed-cycles.ts [--dry-run] [--org ID] [--yes]"
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

function span(window: PeriodWindow): string {
  return `${window.periodStart.toISOString()}..${window.periodEnd.toISOString()}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.dryRun ? "DRY-RUN" : "LIVE";
  console.log(
    `${LOG_PREFIX} mode=${mode} host=${dbHost()} org=${args.org ?? "(all)"}`
  );

  if (!(args.dryRun || args.yes || isLocalDb())) {
    console.error(
      `${LOG_PREFIX} refusing LIVE run against non-local host ${dbHost()} without --yes. Re-run with --yes to confirm, or add --dry-run.`
    );
    process.exit(1);
  }

  const summary = await repairCalendarRowsOverBilledCycles({
    dryRun: args.dryRun,
    organizationId: args.org ?? undefined,
  });
  const verb = args.dryRun ? "WOULD" : "DID";

  for (const cycle of summary.cyclesRecorded) {
    console.log(
      `${LOG_PREFIX}   ${verb} RECORD cycle org=${cycle.organizationId} period=${span(cycle)} total=${cycle.totalExecutions} charge_cents=${cycle.totalChargeCents}`
    );
  }
  for (const row of summary.rowsRewritten) {
    const written = row.written
      ? `period=${span(row.written)} total=${row.written.totalExecutions}`
      : "nothing";
    console.log(
      `${LOG_PREFIX}   ${verb} DELETE row org=${row.organizationId} period=${span(row.deleted)} total=${row.deleted.totalExecutions} -> WRITE ${written}`
    );
  }

  console.log(
    `${LOG_PREFIX} done. mode=${mode} cycles_recorded=${summary.cyclesRecorded.length} rows_rewritten=${summary.rowsRewritten.length}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG_PREFIX} failed:`, err);
    process.exit(1);
  });
