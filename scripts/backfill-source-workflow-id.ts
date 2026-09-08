/**
 * One-shot backfill: populate source_workflow_id for workflows duplicated
 * before the voting feature was added.
 *
 * Strategy: find private workflows whose name ends with " (Copy)" (or
 * " (Copy) N") that lack a source_workflow_id, then match them to the
 * public workflow with the corresponding base name.
 *
 * Usage:
 *   npx tsx scripts/backfill-source-workflow-id.ts          # dry-run
 *   npx tsx scripts/backfill-source-workflow-id.ts --apply   # apply changes
 */

import { eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../lib/db/schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });
const dryRun = !process.argv.includes("--apply");

async function main(): Promise<void> {
  if (dryRun) {
    console.log("[DRY RUN] No changes will be written.\n");
  }

  // Find private workflows without a source that look like copies
  const candidates = await db
    .select({
      id: schema.workflows.id,
      name: schema.workflows.name,
      userId: schema.workflows.userId,
    })
    .from(schema.workflows)
    .where(
      sql`${schema.workflows.sourceWorkflowId} IS NULL
        AND ${schema.workflows.visibility} = 'private'
        AND ${schema.workflows.name} LIKE '% (Copy)%'`
    );

  console.log(`Found ${candidates.length} candidate workflows.\n`);

  // Build a map of public workflow names -> id for matching
  const publicWorkflows = await db
    .select({
      id: schema.workflows.id,
      name: schema.workflows.name,
    })
    .from(schema.workflows)
    .where(eq(schema.workflows.visibility, "public"));

  const publicByName = new Map<string, string>();
  for (const pw of publicWorkflows) {
    publicByName.set(pw.name, pw.id);
  }

  let matched = 0;
  let unmatched = 0;

  for (const candidate of candidates) {
    // Strip " (Copy)" or " (Copy) N" suffix to find the original name
    const baseName = candidate.name.replace(/ \(Copy\)( \d+)?$/, "");
    const sourceId = publicByName.get(baseName);

    if (!sourceId) {
      unmatched++;
      continue;
    }

    matched++;
    console.log(
      `  ${candidate.id}: "${candidate.name}" -> source ${sourceId} ("${baseName}")`
    );

    if (!dryRun) {
      await db
        .update(schema.workflows)
        .set({ sourceWorkflowId: sourceId })
        .where(eq(schema.workflows.id, candidate.id));
    }
  }

  console.log(
    `\nMatched: ${matched}, Unmatched: ${unmatched}, Total: ${candidates.length}`
  );

  if (dryRun && matched > 0) {
    console.log("\nRe-run with --apply to write changes.");
  }

  await client.end();
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
