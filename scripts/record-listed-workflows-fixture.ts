// One-off fixture recorder for the validate_workflow 21-workflow smoke
// test (TEST-01). Run locally against staging or prod DB:
//
//   DATABASE_URL=postgres://... pnpm tsx scripts/record-listed-workflows-fixture.ts
//
// Re-run with a new YYYY-MM-DD in the OUT_FILE constant whenever the
// listed catalog meaningfully changes. Commit the new fixture alongside
// any validator changes that prompted the re-record.
//
// Projected columns (no PII):
//   id, listedSlug -> slug, nodes, edges, inputSchema, outputMapping, isListed, workflowType
//
// Strips: userId, organizationId, name, description, and all other columns.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";

const OUT_FILE = resolve(
  __dirname,
  "../tests/fixtures/listed-workflows-2026-05-16.json"
);

type FixtureWorkflow = {
  id: string;
  slug: string;
  nodes: unknown[];
  edges: unknown[];
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  isListed: boolean;
  workflowType: string;
};

type FixtureFile = {
  recordedAt: string;
  recordedFromEnv: string;
  workflowCount: number;
  workflows: FixtureWorkflow[];
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const rows = await db
    .select({
      id: workflows.id,
      slug: workflows.listedSlug,
      nodes: workflows.nodes,
      edges: workflows.edges,
      inputSchema: workflows.inputSchema,
      outputMapping: workflows.outputMapping,
      isListed: workflows.isListed,
      workflowType: workflows.workflowType,
    })
    .from(workflows)
    .where(eq(workflows.isListed, true));

  if (rows.length === 0) {
    console.error(
      "ERROR: Zero isListed=true workflows returned — refusing to record an empty catalog. Check DATABASE_URL."
    );
    process.exit(1);
  }

  const fixtureWorkflows: FixtureWorkflow[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug ?? r.id,
    nodes: Array.isArray(r.nodes) ? (r.nodes as unknown[]) : [],
    // edges is a top-level jsonb column on the workflows table (lib/db/schema.ts:219).
    // Synthesize empty array defensively — the validator's edge-ref check
    // becomes a no-op for workflows that store connectivity only in nodes.
    edges: Array.isArray(r.edges) ? (r.edges as unknown[]) : [],
    inputSchema:
      r.inputSchema !== undefined && r.inputSchema !== null
        ? (r.inputSchema as Record<string, unknown>)
        : null,
    outputMapping:
      r.outputMapping !== undefined && r.outputMapping !== null
        ? (r.outputMapping as Record<string, unknown>)
        : null,
    isListed: r.isListed,
    workflowType: r.workflowType ?? "read",
  }));

  for (const wf of fixtureWorkflows) {
    const nodeCount = Array.isArray(wf.nodes) ? wf.nodes.length : 0;
    console.log(`[OK] ${wf.slug} (${nodeCount} nodes)`);
  }

  const fixture: FixtureFile = {
    recordedAt: new Date().toISOString(),
    recordedFromEnv: process.env.NODE_ENV ?? "unknown",
    workflowCount: fixtureWorkflows.length,
    workflows: fixtureWorkflows,
  };

  if (dryRun) {
    console.log(
      `Dry run — would write ${fixtureWorkflows.length} workflows to ${OUT_FILE}`
    );
    process.exit(0);
  }

  writeFileSync(OUT_FILE, JSON.stringify(fixture, null, 2), "utf8");
  console.log(
    `Wrote ${fixtureWorkflows.length} workflows to ${OUT_FILE}`
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
