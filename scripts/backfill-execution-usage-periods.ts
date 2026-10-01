/**
 * One-time backfill of `execution_usage_periods`.
 *
 * Every closed billing period's usage figure currently exists only as the
 * `workflow_executions` rows themselves, and the invoices page recomputes it
 * from those rows on every load. The run-row retention pass deletes rows past a
 * flat window, so it cannot be turned on until history is frozen in a record.
 * This script writes the records for the periods still reconstructible.
 *
 * Period shapes, matching how the live writers derive them:
 *
 * - An organization with a provider customer is backfilled from the periods its
 *   provider reports on its invoices. Those are exactly the periods the
 *   invoices page renders, so a backfilled row and a rendered row describe the
 *   same span.
 * - Every other organization is backfilled per UTC calendar month, from the
 *   month of its first execution up to the month that closed most recently.
 *
 * Only closed periods are written: `recordClosedPeriodUsage` refuses an open
 * one, because freezing a partial count as final is worse than having no row.
 * Writes are idempotent through the unique key on
 * (organization_id, period_start, period_end), so a re-run adds only what is
 * missing and a resumed run cannot double-count.
 *
 * Plan, tier and limit are recorded as they stand today. For history that is
 * the best available: nothing stores what plan an organization was on during a
 * period that has already closed. Periods closed by the live writers from here
 * on record the plan in force at the close.
 *
 * A LIVE run against a non-local DB requires --yes; dry-runs and local DBs do
 * not. This is a guard against an accidental prod write, not a security
 * boundary.
 *
 * `--conditions=react-server` is required: the billing modules this reuses are
 * marked `server-only`, whose default entry throws outside a server component.
 * That condition resolves it to the package's own empty module, which is what
 * Next does for a server component too.
 *
 * Usage:
 *   pnpm tsx --conditions=react-server scripts/backfill-execution-usage-periods.ts --dry-run
 *   pnpm tsx --conditions=react-server scripts/backfill-execution-usage-periods.ts             # local DB
 *   pnpm tsx --conditions=react-server scripts/backfill-execution-usage-periods.ts --yes       # staging/prod
 *   pnpm tsx --conditions=react-server scripts/backfill-execution-usage-periods.ts --yes --org <id>
 *   pnpm tsx --conditions=react-server scripts/backfill-execution-usage-periods.ts --dry-run --max-orgs 5
 */

import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import {
  addMonthsUtc,
  countExecutionsByOrgForPeriod,
  countExecutionsForPeriod,
  monthStartUtc,
  getRecordedOrganizationIds,
  type PeriodWindow,
  previousCalendarMonth,
  readPlanSnapshot,
  recordClosedPeriodUsage,
} from "@/lib/billing/execution-usage-periods";
import { getBillingProvider } from "@/lib/billing/providers";
import { db } from "@/lib/db";
import {
  organizationSubscriptions,
  overageBillingRecords,
} from "@/lib/db/schema";

const LOG_PREFIX = "[backfill-execution-usage-periods]";
const INVOICE_PAGE_SIZE = 100;

type CliArgs = {
  dryRun: boolean;
  yes: boolean;
  org: string | null;
  maxOrgs: number | null;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, yes: false, org: null, maxOrgs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--yes") {
      args.yes = true;
    } else if (a === "--org" && argv[i + 1]) {
      args.org = argv[i + 1];
      i++;
    } else if (a === "--max-orgs" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.maxOrgs = parsed;
      }
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: pnpm tsx scripts/backfill-execution-usage-periods.ts [--dry-run] [--org ID] [--max-orgs N] [--yes]"
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
    const hostname = new URL(process.env.DATABASE_URL ?? "").hostname.replace(
      /^\[|\]$/g,
      ""
    );
    return LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Earliest execution an organization has, from either side of the billable
 * count. Drives how far back the calendar-month walk goes; an organization with
 * no executions at all has no period worth recording.
 */
async function earliestActivity(organizationId: string): Promise<Date | null> {
  const rows = await db.execute<{ first_seen: string | null }>(
    sql`SELECT LEAST(
          (
            SELECT MIN(we.started_at)
              FROM workflow_executions we
              JOIN workflows w ON we.workflow_id = w.id
             WHERE w.organization_id = ${organizationId}
          ),
          (
            SELECT MIN(de.created_at)
              FROM direct_executions de
             WHERE de.organization_id = ${organizationId}
          )
        ) AS first_seen`
  );
  const value = rows[0]?.first_seen;
  return value ? new Date(value) : null;
}

/** Every closed UTC month from the organization's first activity onwards. */
async function calendarMonthWindows(
  organizationId: string,
  now: Date
): Promise<PeriodWindow[]> {
  const first = await earliestActivity(organizationId);
  if (!first) {
    return [];
  }

  const lastClosed = previousCalendarMonth(now).periodStart;
  const windows: PeriodWindow[] = [];
  for (
    let start = monthStartUtc(first);
    start <= lastClosed;
    start = addMonthsUtc(start, 1)
  ) {
    windows.push({ periodStart: start, periodEnd: addMonthsUtc(start, 1) });
  }
  return windows;
}

/** Every period the provider reports on the organization's invoices. */
async function providerInvoiceWindows(
  customerId: string
): Promise<PeriodWindow[]> {
  const provider = getBillingProvider();
  const windows: PeriodWindow[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await provider.listInvoices({
      customerId,
      limit: INVOICE_PAGE_SIZE,
      startingAfter,
    });
    for (const invoice of page.invoices) {
      windows.push({
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      });
    }
    if (!page.hasMore || page.invoices.length === 0) {
      return windows;
    }
    startingAfter = page.invoices.at(-1)?.id;
    if (!startingAfter) {
      return windows;
    }
  }
}

/**
 * What a period was billed on, when it produced an overage at the time.
 *
 * `overage_billing_records` froze the limit, the total and the overage count
 * alongside the charge, so for any period with a billed record this is strictly
 * better than today's plan. Taking only the charge and letting the current plan
 * supply the rest produces a row that contradicts itself: an organization that
 * has upgraded since gets `overageCount = 0` beside a non-zero charge, and the
 * Billing History table renders that usage figure in the same row as the
 * invoice amount - an overage charge next to a claim the customer was inside
 * their limit.
 */
type BilledPeriodFacts = {
  executionLimit: number;
  totalExecutions: number;
  overageCount: number;
  totalChargeCents: number;
};

async function billedPeriodFacts(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<BilledPeriodFacts | undefined> {
  const rows = await db
    .select({
      executionLimit: overageBillingRecords.executionLimit,
      totalExecutions: overageBillingRecords.totalExecutions,
      overageCount: overageBillingRecords.overageCount,
      totalChargeCents: overageBillingRecords.totalChargeCents,
    })
    .from(overageBillingRecords)
    .where(
      and(
        eq(overageBillingRecords.organizationId, organizationId),
        eq(overageBillingRecords.periodStart, periodStart),
        eq(overageBillingRecords.periodEnd, periodEnd),
        eq(overageBillingRecords.status, "billed")
      )
    )
    .limit(1);
  return rows[0];
}

/**
 * Invoice windows, plus the calendar months no invoice window covers.
 *
 * A month overlapping an invoice window is dropped rather than written
 * alongside it: the invoice window is what the customer was actually billed
 * on, and the page looks a period up by its exact bounds.
 */
/** Whether this window came from the provider's invoices. */
function isInvoiceWindow(
  window: PeriodWindow,
  invoiceWindows: PeriodWindow[]
): boolean {
  return invoiceWindows.some(
    (invoice) =>
      invoice.periodStart.getTime() === window.periodStart.getTime() &&
      invoice.periodEnd.getTime() === window.periodEnd.getTime()
  );
}

function mergeWindows(
  invoiceWindows: PeriodWindow[],
  monthWindows: PeriodWindow[]
): PeriodWindow[] {
  if (invoiceWindows.length === 0) {
    return monthWindows;
  }
  const uncovered = monthWindows.filter(
    (month) =>
      !invoiceWindows.some(
        (invoice) =>
          month.periodStart < invoice.periodEnd &&
          invoice.periodStart < month.periodEnd
      )
  );
  return [...invoiceWindows, ...uncovered];
}

type OrgOutcome = { written: number; skipped: number };

async function backfillOrg(
  organizationId: string,
  providerCustomerId: string | null,
  now: Date,
  dryRun: boolean
): Promise<OrgOutcome> {
  // Not either/or. `ensureProviderCustomer` writes providerCustomerId when the
  // checkout session is created, with plan "free" and before any payment, so
  // merely opening the checkout page would otherwise divert an organization to
  // the invoice branch and leave it with no rows at all. A paying organization
  // likewise has months before its first invoice and after its last that no
  // invoice window covers, and the month close only ever closes recent months,
  // so nothing else would fill them. The unique key makes the overlap safe.
  const invoiceWindows = providerCustomerId
    ? await providerInvoiceWindows(providerCustomerId)
    : [];
  const monthWindows = await calendarMonthWindows(organizationId, now);
  const windows = mergeWindows(invoiceWindows, monthWindows);

  const closed = windows.filter((window) => window.periodEnd <= now);
  if (closed.length === 0) {
    return { written: 0, skipped: 0 };
  }

  // One plan read per organization rather than one per period.
  const planSnapshot = await readPlanSnapshot(organizationId);

  let written = 0;
  let skipped = 0;

  for (const window of closed) {
    const recorded = await getRecordedOrganizationIds(
      [organizationId],
      window.periodStart,
      window.periodEnd
    );
    if (recorded.has(organizationId)) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      const counts = await countExecutionsForPeriod(
        organizationId,
        window.periodStart,
        window.periodEnd
      );
      console.log(
        `${LOG_PREFIX}   WOULD WRITE org=${organizationId} period=${window.periodStart.toISOString()}..${window.periodEnd.toISOString()} workflow=${counts.workflowExecutions} direct=${counts.directExecutions} total=${counts.total}`
      );
      written += 1;
      continue;
    }

    // A billed record for this exact period knows what the period was billed
    // on. Prefer it over today's plan for everything it stores, not just the
    // charge, or the row contradicts itself.
    const billed = await billedPeriodFacts(
      organizationId,
      window.periodStart,
      window.periodEnd
    );
    const counts = await countExecutionsForPeriod(
      organizationId,
      window.periodStart,
      window.periodEnd
    );

    const result = await recordClosedPeriodUsage(
      {
        organizationId,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        source: isInvoiceWindow(window, invoiceWindows)
          ? "subscription"
          : "calendar_month",
        // A billed record supplies the limit it was billed against. The plan
        // name and tier are NOT taken from it: it does not store them, and
        // pairing today's plan with a historical limit produces a row that
        // reads as the current plan beside a limit that plan never had. Where
        // a billed record exists the limit is what the invoice is reconciled
        // against, so the limit is the field worth being exact about.
        planSnapshot: billed
          ? {
              plan: planSnapshot.plan,
              tier: planSnapshot.tier,
              executionLimit: billed.executionLimit,
            }
          : planSnapshot,
        // The billed halves are not stored, only the total, so the live halves
        // are kept as they are rather than synthesized from it. Clamping the
        // workflow half to absorb the difference silently broke the invariant
        // that the halves sum to the total, and it becomes reachable the moment
        // run-row retention starts removing workflow rows - which is exactly
        // when someone re-runs this script.
        counts,
        billedTotalExecutions: billed?.totalExecutions,
        billedOverageCount: billed?.overageCount,
        totalChargeCents: billed?.totalChargeCents,
      },
      now
    );
    if (result.recorded) {
      written += 1;
    } else {
      skipped += 1;
    }
  }

  return { written, skipped };
}

type BackfillTarget = {
  organizationId: string;
  providerCustomerId: string | null;
};

/**
 * Every organization this backfill has to visit.
 *
 * Enumerating `organization_subscriptions` is not enough and was the bug this
 * script shipped with: on production 1,088 of 1,525 organizations have no row
 * in that table at all, and 397 of those have run executions. They are exactly
 * the free-plan organizations the record is meant to cover, and skipping them
 * loses 490 of the 892 org-months that should exist.
 *
 * So the list is driven by activity -- every organization that ever ran
 * something -- unioned with every organization holding a provider customer,
 * which is how an organization that has invoices but no executions in range
 * still gets visited. `earliestActivity` below then bounds each one's months,
 * and an organization with no customer id takes the calendar-month path.
 */
async function organizationsToBackfill(
  onlyOrg: string | null,
  now: Date
): Promise<BackfillTarget[]> {
  const customerByOrg = new Map<string, string | null>(
    (
      await db
        .select({
          organizationId: organizationSubscriptions.organizationId,
          providerCustomerId: organizationSubscriptions.providerCustomerId,
        })
        .from(organizationSubscriptions)
    ).map((row) => [row.organizationId, row.providerCustomerId])
  );

  // Everything that has ever run, in one aggregate: from the first execution
  // on record up to the end of the month that closed most recently.
  const active = await countExecutionsByOrgForPeriod(
    new Date(0),
    previousCalendarMonth(now).periodEnd
  );

  const ids = new Set<string>(active.map((row) => row.organizationId));
  for (const [organizationId, customerId] of customerByOrg) {
    if (customerId) {
      ids.add(organizationId);
    }
  }

  const targets = [...ids].map((organizationId) => ({
    organizationId,
    providerCustomerId: customerByOrg.get(organizationId) ?? null,
  }));

  return onlyOrg
    ? targets.filter((t) => t.organizationId === onlyOrg)
    : targets;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  console.log(
    `${LOG_PREFIX} mode=${args.dryRun ? "DRY-RUN" : "LIVE"} host=${dbHost()} org=${args.org ?? "(all)"} maxOrgs=${args.maxOrgs ?? "all"}`
  );

  if (!(args.dryRun || args.yes || isLocalDb())) {
    console.error(
      `${LOG_PREFIX} refusing LIVE run against non-local host ${dbHost()} without --yes. Re-run with --yes to confirm, or add --dry-run.`
    );
    process.exit(1);
  }

  const subs = await organizationsToBackfill(args.org, now);
  const selected = args.maxOrgs ? subs.slice(0, args.maxOrgs) : subs;
  console.log(`${LOG_PREFIX} organizations to visit: ${selected.length}`);

  let orgs = 0;
  let totalWritten = 0;
  let totalSkipped = 0;
  let failed = 0;

  for (const sub of selected) {
    try {
      const outcome = await backfillOrg(
        sub.organizationId,
        sub.providerCustomerId,
        now,
        args.dryRun
      );
      orgs += 1;
      totalWritten += outcome.written;
      totalSkipped += outcome.skipped;
      console.log(
        `${LOG_PREFIX} org=${sub.organizationId} written=${outcome.written} skipped=${outcome.skipped} cumulative_written=${totalWritten}`
      );
    } catch (error) {
      // One organization must not abort the run; re-running picks it up again
      // because nothing was written for it.
      failed += 1;
      console.error(
        `${LOG_PREFIX} org=${sub.organizationId} FAILED:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  console.log(
    `${LOG_PREFIX} done. mode=${args.dryRun ? "DRY-RUN" : "LIVE"} orgs=${orgs} written=${totalWritten} skipped=${totalSkipped} failed=${failed}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG_PREFIX} failed:`, err);
    process.exit(1);
  });
