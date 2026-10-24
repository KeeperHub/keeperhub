/**
 * KEEP-545: one-time backfill of `error_category` and `error_type`
 * columns on `workflow_executions` rows for managed-client orgs (Sky and
 * Ajna) over the last 90 days.
 *
 * The DB schema migration that added these columns leaves them null on
 * historical rows. The SLA alert post-PR-2 watches the new counter, not
 * the historical column, so backfill is not required for the alert. The
 * reason to run this is to produce an immediate inventory of "real
 * engineering failures vs user-config noise" inside the managed-client
 * scope without writing one-off SQL.
 *
 * Idempotent: skips rows that already have both classification columns
 * set. Safe to re-run.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-error-classification.ts --dry-run
 *   pnpm tsx scripts/backfill-error-classification.ts
 *   pnpm tsx scripts/backfill-error-classification.ts --orgs sky,ajna --days 30
 *
 * Output:
 *   - Progress lines per batch (`processed=N updated=M skipped=K`)
 *   - Final summary table by (org_slug, error_category, error_type)
 */

import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, workflowExecutions, workflows } from "@/lib/db/schema";
import { classifyExecutionError } from "@/lib/errors/classify";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";

const DEFAULT_ORGS = ["techops-services", "ajna"];
const DEFAULT_DAYS = 90;
const BATCH_SIZE = 500;

type CliArgs = {
  dryRun: boolean;
  orgs: string[];
  days: number;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    orgs: DEFAULT_ORGS,
    days: DEFAULT_DAYS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--orgs" && argv[i + 1]) {
      args.orgs = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--days" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.days = parsed;
      }
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: pnpm tsx scripts/backfill-error-classification.ts [--dry-run] [--orgs slug1,slug2] [--days N]"
      );
      process.exit(0);
    }
  }
  return args;
}

type RowToClassify = {
  id: string;
  error: string | null;
  orgSlug: string | null;
};

async function fetchUnclassifiedBatch(args: {
  orgs: string[];
  days: number;
  afterId: string | null;
}): Promise<RowToClassify[]> {
  const startedAtCutoff = new Date(
    Date.now() - args.days * 24 * 60 * 60 * 1000
  );

  return db
    .select({
      id: workflowExecutions.id,
      error: workflowExecutions.error,
      orgSlug: organization.slug,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .innerJoin(organization, eq(workflows.organizationId, organization.id))
    .where(
      and(
        eq(workflowExecutions.status, "error"),
        gte(workflowExecutions.startedAt, startedAtCutoff),
        inArray(organization.slug, args.orgs),
        or(
          isNull(workflowExecutions.errorCategory),
          isNull(workflowExecutions.errorType)
        ),
        args.afterId ? sql`${workflowExecutions.id} > ${args.afterId}` : undefined
      )
    )
    .orderBy(workflowExecutions.id)
    .limit(BATCH_SIZE);
}

type Summary = Record<
  string,
  Record<string, Record<ExecutionErrorType, number>>
>;

function recordInSummary(
  summary: Summary,
  orgSlug: string,
  errorCategory: string,
  errorType: ExecutionErrorType
): void {
  if (!summary[orgSlug]) {
    summary[orgSlug] = {};
  }
  if (!summary[orgSlug][errorCategory]) {
    summary[orgSlug][errorCategory] = {
      user: 0,
      system: 0,
      external: 0,
      // KEEP-1080 added a fourth fault domain. Counting it keeps the totals
      // honest; leaving it out would silently drop policy denials from the
      // report rather than showing them as zero.
      policy: 0,
    };
  }
  summary[orgSlug][errorCategory][errorType] += 1;
}

function formatSummary(summary: Summary): string {
  const lines: string[] = [];
  lines.push(
    "org_slug              | error_category       |   user |  system | external | policy | total"
  );
  lines.push(
    "----------------------+----------------------+--------+---------+----------+--------+-------"
  );
  for (const orgSlug of Object.keys(summary).sort()) {
    for (const cat of Object.keys(summary[orgSlug]).sort()) {
      const { user, system, external, policy } = summary[orgSlug][cat];
      lines.push(
        `${orgSlug.padEnd(22)}| ${cat.padEnd(21)}| ${String(user).padStart(6)} | ${String(system).padStart(7)} | ${String(external).padStart(8)} | ${String(policy).padStart(6)} | ${String(user + system + external + policy).padStart(5)}`
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-error-classification] mode=${args.dryRun ? "DRY-RUN" : "LIVE"} orgs=${args.orgs.join(",")} days=${args.days}`
  );

  const summary: Summary = {};
  let totalProcessed = 0;
  let totalUpdated = 0;
  let afterId: string | null = null;

  for (;;) {
    const rows = await fetchUnclassifiedBatch({
      orgs: args.orgs,
      days: args.days,
      afterId,
    });
    if (rows.length === 0) {
      break;
    }

    let updatedInBatch = 0;
    for (const row of rows) {
      const orgSlug = row.orgSlug ?? "_anonymous";
      const { errorCategory, errorType } = classifyExecutionError(row.error);
      recordInSummary(summary, orgSlug, errorCategory, errorType);

      if (!args.dryRun) {
        await db
          .update(workflowExecutions)
          .set({ errorCategory, errorType })
          .where(eq(workflowExecutions.id, row.id));
        updatedInBatch += 1;
      }
    }

    totalProcessed += rows.length;
    totalUpdated += updatedInBatch;
    afterId = rows[rows.length - 1].id;

    console.log(
      `[backfill-error-classification] batch: processed=${rows.length} updated=${updatedInBatch} cumulative=${totalProcessed}`
    );

    if (rows.length < BATCH_SIZE) {
      break;
    }
  }

  console.log("");
  console.log(
    `[backfill-error-classification] done. total_processed=${totalProcessed} total_updated=${totalUpdated} mode=${args.dryRun ? "DRY-RUN" : "LIVE"}`
  );
  console.log("");
  console.log("Breakdown:");
  console.log(formatSummary(summary));
}

main().catch((err) => {
  console.error("[backfill-error-classification] failed:", err);
  process.exit(1);
});
