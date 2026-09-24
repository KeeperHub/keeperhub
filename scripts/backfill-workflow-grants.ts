/**
 * Issue each workflow the grants it needs, derived from what it is built out of.
 *
 * A grant says what a workflow can reach at all. Until something issues them
 * every workflow reached everything, because the guard treats a subject with no
 * grants as one that predates the layer and lets it through. That default is
 * what makes this backfill safe to run gradually, and it is also why running it
 * on a workflow is the moment that workflow becomes constrained.
 *
 * So it is deliberately conservative. A workflow whose target is a template is
 * skipped whole, because granting the nodes we can pin and not the one we
 * cannot would leave the workflow holding a grant that its own node falls
 * outside of, and the run would fail at that node. Those are reported for
 * someone to decide about rather than guessed at.
 *
 * Reports by default. Pass --apply to write.
 *
 *   DATABASE_URL=... pnpm tsx scripts/backfill-workflow-grants.ts [--apply] [--org <id>]
 */
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resourceGrants } from "@/lib/db/schema-policy";
import { workflows } from "@/lib/db/schema";
import { deriveWorkflowGrants } from "@/lib/policy/grant-derivation";

const apply = process.argv.includes("--apply");
const orgFlag = process.argv.indexOf("--org");
const onlyOrg = orgFlag === -1 ? null : process.argv[orgFlag + 1];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      organizationId: workflows.organizationId,
      nodes: workflows.nodes,
      userId: workflows.userId,
    })
    .from(workflows)
    .where(isNull(workflows.deletedAt));

  let granted = 0;
  let skipped = 0;
  let nothingToGrant = 0;

  for (const row of rows) {
    if (!row.organizationId) {
      continue;
    }
    if (onlyOrg && row.organizationId !== onlyOrg) {
      continue;
    }

    const nodes = Array.isArray(row.nodes) ? row.nodes : [];
    const { grants, unpinnable } = deriveWorkflowGrants(
      nodes as Parameters<typeof deriveWorkflowGrants>[0]
    );

    if (unpinnable.length > 0) {
      skipped++;
      process.stdout.write(
        `  skip    ${row.name}\n          ${unpinnable.length} node(s) name a target only known at run time: ${unpinnable
          .map((n) => n.nodeId)
          .join(", ")}\n`
      );
      continue;
    }
    if (grants.length === 0) {
      nothingToGrant++;
      continue;
    }

    granted++;
    process.stdout.write(`  grant   ${row.name}\n`);
    for (const grant of grants) {
      process.stdout.write(
        `          ${grant.resource}  ${grant.capabilities.join(", ")}\n`
      );
    }

    if (!apply) {
      continue;
    }

    for (const grant of grants) {
      const existing = await db
        .select({ id: resourceGrants.id })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.organizationId, row.organizationId),
            eq(resourceGrants.subjectKind, "workflow"),
            eq(resourceGrants.subjectId, row.id),
            eq(resourceGrants.resource, grant.resource),
            isNull(resourceGrants.revokedAt)
          )
        )
        .limit(1);
      if (existing.length > 0) {
        continue;
      }
      await db.insert(resourceGrants).values({
        organizationId: row.organizationId,
        subjectKind: "workflow",
        subjectId: row.id,
        resource: grant.resource,
        capabilities: grant.capabilities,
        grantedBy: row.userId,
      });
    }
  }

  process.stdout.write(
    `\n${apply ? "applied" : "would grant"}: ${granted} workflow(s)\n` +
      `skipped, target known only at run time: ${skipped}\n` +
      `nothing onchain to grant: ${nothingToGrant}\n`
  );
  if (!apply) {
    process.stdout.write("\nNothing was written. Pass --apply to write.\n");
  }

  await sql.end();
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
