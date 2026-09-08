#!/usr/bin/env tsx

/**
 * Read-only audit: find workflows bound to a Connection (integration) that
 * belongs to a different organization than the workflow itself.
 *
 * Background: before the org-scoped picker / runtime guards landed, a workflow
 * node could be (and at least one was) silently rebound to another org's
 * database connection. This script reports any currently-corrupted bindings so
 * they can be repaired manually. It NEVER writes - repointing a workflow to the
 * correct connection is an explicit, reviewed action done separately.
 *
 * A binding is flagged when the referenced integration's organizationId does
 * not equal the workflow's organizationId. Deleted/unknown integration ids are
 * reported separately (informational - a stale reference is not a leak).
 *
 * Usage:
 *   npx tsx scripts/audit-cross-org-connections.ts
 */

import { inArray } from "drizzle-orm";
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

type WorkflowNode = {
  id?: string;
  data?: { config?: { integrationId?: unknown } };
};

function integrationIdsOf(nodes: WorkflowNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    const id = node?.data?.config?.integrationId;
    if (typeof id === "string" && id.length > 0) {
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

async function main(): Promise<void> {
  const workflows = await db
    .select({
      id: schema.workflows.id,
      name: schema.workflows.name,
      organizationId: schema.workflows.organizationId,
      nodes: schema.workflows.nodes,
    })
    .from(schema.workflows);

  // Gather every referenced integration id across all workflows, then resolve
  // their owning org in a single query.
  const allIds = new Set<string>();
  for (const wf of workflows) {
    for (const id of integrationIdsOf((wf.nodes ?? []) as WorkflowNode[])) {
      allIds.add(id);
    }
  }

  const orgByIntegrationId = new Map<string, string | null>();
  if (allIds.size > 0) {
    const rows = await db
      .select({
        id: schema.integrations.id,
        organizationId: schema.integrations.organizationId,
      })
      .from(schema.integrations)
      .where(inArray(schema.integrations.id, [...allIds]));
    for (const row of rows) {
      orgByIntegrationId.set(row.id, row.organizationId);
    }
  }

  const crossOrg: string[] = [];
  const missing: string[] = [];

  for (const wf of workflows) {
    for (const id of integrationIdsOf((wf.nodes ?? []) as WorkflowNode[])) {
      if (!orgByIntegrationId.has(id)) {
        missing.push(
          `  workflow ${wf.id} ("${wf.name}", org ${wf.organizationId}) -> connection ${id} [not found / deleted]`
        );
        continue;
      }
      const integrationOrg = orgByIntegrationId.get(id) ?? null;
      if (integrationOrg !== wf.organizationId) {
        crossOrg.push(
          `  workflow ${wf.id} ("${wf.name}", org ${wf.organizationId}) -> connection ${id} (org ${integrationOrg ?? "personal/null"})`
        );
      }
    }
  }

  console.log(`Scanned ${workflows.length} workflows.\n`);

  console.log(`Cross-org connection bindings: ${crossOrg.length}`);
  if (crossOrg.length > 0) {
    console.log(crossOrg.join("\n"));
  }

  console.log(`\nStale (deleted) connection references: ${missing.length}`);
  if (missing.length > 0) {
    console.log(missing.join("\n"));
  }

  await client.end();
  // Non-zero exit when leaks are present so the script is CI-usable as a gate.
  process.exit(crossOrg.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
