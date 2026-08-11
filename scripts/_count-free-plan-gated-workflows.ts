#!/usr/bin/env tsx
/**
 * Read-only count of free-plan workflows affected by extractActionTypeNodes
 * hardening (legacy top-level actionType + colon-to-slash normalization).
 *
 * Usage: pnpm tsx scripts/_count-free-plan-gated-workflows.ts
 */

import "dotenv/config";

import { and, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { workflowRequiredPlan } from "@/lib/features/template-plan-gate";
import { validateWorkflowFeatures } from "@/lib/features/workflow-validator";
import { organizationSubscriptions, workflows } from "@/lib/db/schema";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

/** Pre-PR extract: config.actionType only, no legacy top-level, no colon normalization. */
function extractActionTypeNodesLegacy(nodes: readonly unknown[]) {
  const refs: Array<{ id: string; actionType: string }> = [];
  if (!Array.isArray(nodes)) {
    return refs;
  }
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const node = raw as {
      id?: unknown;
      data?: { config?: { actionType?: unknown } };
    };
    const id = typeof node.id === "string" ? node.id : null;
    const actionType = node.data?.config?.actionType;
    if (!id || typeof actionType !== "string") {
      continue;
    }
    refs.push({ id, actionType });
  }
  return refs;
}

function legacyRequiredPlan(nodes: readonly unknown[]) {
  const violations = validateWorkflowFeatures(
    extractActionTypeNodesLegacy(nodes),
    "free"
  );
  return violations.length > 0 ? "gated" : null;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  // Match getOrgPlan: missing subscription row means free.
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      nodes: workflows.nodes,
    })
    .from(workflows)
    .leftJoin(
      organizationSubscriptions,
      eq(workflows.organizationId, organizationSubscriptions.organizationId)
    )
    .where(
      and(
        workflowNotDeleted(),
        or(
          isNull(organizationSubscriptions.plan),
          eq(organizationSubscriptions.plan, "free")
        ),
        isNull(workflows.deactivatedAt)
      )
    );

  let gatedAfter = 0;
  let newlyGated = 0;
  const samples: Array<{ id: string; name: string }> = [];

  for (const row of rows) {
    const nodes = Array.isArray(row.nodes) ? (row.nodes as unknown[]) : [];
    const after = workflowRequiredPlan(nodes);
    const before = legacyRequiredPlan(nodes);

    if (after !== null) {
      gatedAfter += 1;
    }
    if (before === null && after !== null) {
      newlyGated += 1;
      if (samples.length < 10) {
        samples.push({ id: row.id, name: row.name });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        freePlanActiveWorkflows: rows.length,
        gatedAfterHardening: gatedAfter,
        newlyGatedByHardening: newlyGated,
        samples,
      },
      null,
      2
    )
  );

  await client.end();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
