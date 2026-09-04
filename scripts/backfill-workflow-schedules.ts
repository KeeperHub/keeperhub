/**
 * One-shot backfill: create the missing workflow_schedules row for enabled
 * workflows that carry a Schedule trigger but were never registered with the
 * dispatcher.
 *
 * Those rows were only ever written on a definition save, so a workflow
 * created through /api/workflows/create, duplicate or import and then enabled
 * without a further edit never got one and never fired.
 *
 * Seeded and featured showcase rows are skipped: they ship enabled so the hub
 * can render them, and registering their schedules would start running them for
 * real. Review the dry-run list before applying.
 *
 * Usage:
 *   npx tsx scripts/backfill-workflow-schedules.ts                     # dry-run
 *   npx tsx scripts/backfill-workflow-schedules.ts --apply
 *   npx tsx scripts/backfill-workflow-schedules.ts --include-disabled
 */

import { and, eq, isNull } from "drizzle-orm";
import { IntervalTooSmallError } from "@/lib/cron-utils";
import { db } from "@/lib/db";
import { workflowSchedules, workflows } from "@/lib/db/schema";
import {
  extractScheduleConfig,
  syncWorkflowSchedule,
} from "@/lib/schedule-service";
import type { WorkflowNode } from "@/lib/workflow/store";

const dryRun = !process.argv.includes("--apply");
const includeDisabled = process.argv.includes("--include-disabled");

async function main(): Promise<void> {
  if (dryRun) {
    console.log("[DRY RUN] No changes will be written.\n");
  }

  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      nodes: workflows.nodes,
    })
    .from(workflows)
    .leftJoin(workflowSchedules, eq(workflowSchedules.workflowId, workflows.id))
    .where(
      and(
        isNull(workflowSchedules.id),
        isNull(workflows.deletedAt),
        isNull(workflows.seededAt),
        eq(workflows.featured, false),
        includeDisabled ? undefined : eq(workflows.enabled, true)
      )
    );

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const nodes = Array.isArray(row.nodes) ? (row.nodes as WorkflowNode[]) : [];

    let config: ReturnType<typeof extractScheduleConfig>;
    try {
      config = extractScheduleConfig(nodes);
    } catch (error) {
      if (error instanceof IntervalTooSmallError) {
        console.warn(`${row.id} (${row.name}): ${error.message}`);
        failed += 1;
        continue;
      }
      throw error;
    }

    if (!config) {
      skipped += 1;
      continue;
    }

    const detail =
      config.mode === "cron"
        ? `${config.cronExpression} (${config.timezone})`
        : `every ${config.intervalSeconds}s (${config.timezone})`;
    console.log(`${row.id} (${row.name}): ${detail}`);

    if (dryRun) {
      created += 1;
      continue;
    }

    const result = await syncWorkflowSchedule(row.id, nodes);
    if (result.synced) {
      created += 1;
    } else {
      console.warn(`  sync failed: ${result.error}`);
      failed += 1;
    }
  }

  console.log(
    `\nScanned ${rows.length} workflow(s) with no schedule row: ` +
      `${created} ${dryRun ? "would be registered" : "registered"}, ` +
      `${skipped} without a Schedule trigger, ${failed} failed.`
  );

  if (dryRun && created > 0) {
    console.log("Re-run with --apply to write the rows.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
  });
