#!/usr/bin/env tsx

/**
 * backfill-workflow-history.ts
 *
 * Seed a version-1 "created" baseline for every workflow that predates the
 * version-history feature (i.e. has no rows in `workflow_history` yet).
 *
 * Why: history rows are only written on create/update since the feature
 * shipped. A workflow created before it has zero versions, so its first edit
 * lands as "Version 1" with a diff against the (unrecorded) creation state --
 * the creation baseline is missing. This inserts that baseline so the first
 * real edit becomes Version 2 and the timeline starts at "created".
 *
 * The synthesized row mirrors what the create path records: full snapshot of
 * the current definition, `change = null`, `source = "create"`, the real
 * content hash, attributed to the workflow's creator, and backdated to the
 * workflow's `createdAt`.
 *
 * Safety:
 *   - Idempotent: only touches workflows with NO existing history, so
 *     re-running (or running on every deploy) is a no-op after the first pass.
 *   - Never renumbers or edits existing history rows.
 *
 * Usage: pnpm tsx scripts/backfill-workflow-history.ts
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowHistory, workflows } from "@/lib/db/schema";
import { hashWorkflowDefinition } from "@/lib/workflow/content-hash";
import { generateId } from "@/lib/utils/id";

const CHUNK_SIZE = 500;

type WorkflowRow = typeof workflows.$inferSelect;

// Mirrors buildSnapshot in lib/workflow/history.ts. Inlined so this script
// avoids that module's transitive server-only imports (version-diff ->
// step-registry).
function buildSnapshot(wf: WorkflowRow): Record<string, unknown> {
  return {
    name: wf.name ?? null,
    description: wf.description ?? null,
    nodes: wf.nodes ?? [],
    edges: wf.edges ?? [],
    visibility: wf.visibility ?? null,
    enabled: wf.enabled ?? null,
    isListed: wf.isListed ?? null,
    listedSlug: wf.listedSlug ?? null,
    inputSchema: wf.inputSchema ?? null,
    outputMapping: wf.outputMapping ?? null,
    priceUsdcPerCall: wf.priceUsdcPerCall ?? null,
    workflowType: wf.workflowType ?? null,
    category: wf.category ?? null,
    chain: wf.chain ?? null,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  return [items.slice(0, size), ...chunk(items.slice(size), size)];
}

async function main(): Promise<void> {
  const pending = await db
    .select()
    .from(workflows)
    .where(
      sql`not exists (select 1 from ${workflowHistory} h where h.workflow_id = ${workflows.id})`
    );

  console.log(
    `[workflow-history] ${pending.length} workflow(s) without history; seeding v1 "created" baselines.`
  );
  if (pending.length === 0) {
    return;
  }

  const rows = pending.map((wf) => ({
    id: generateId(),
    workflowId: wf.id,
    organizationId: wf.organizationId,
    version: 1,
    changedByUserId: wf.userId,
    authMethod: "internal",
    source: "create",
    snapshot: buildSnapshot(wf),
    change: null,
    contentHash: hashWorkflowDefinition(wf.nodes, wf.edges),
    previousVersion: null,
    previousHash: null,
    createdAt: wf.createdAt,
  }));

  let inserted = 0;
  for (const batch of chunk(rows, CHUNK_SIZE)) {
    await db.insert(workflowHistory).values(batch);
    inserted += batch.length;
    console.log(`[workflow-history] inserted ${inserted}/${rows.length}`);
  }

  console.log(`[workflow-history] done: ${inserted} baseline version(s) added.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[workflow-history] backfill failed:", error);
    process.exit(1);
  });
