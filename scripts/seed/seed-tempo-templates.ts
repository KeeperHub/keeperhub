#!/usr/bin/env tsx

/**
 * Seed the three Tempo demo workflow templates as listed, public,
 * deployable workflows (invoice reconciliation, batch payroll, treasury
 * sweep). They surface automatically through /api/workflows/public and MCP
 * deploy_template.
 *
 * Templates are seeded with `enabled: false`: they are clone targets, not
 * live workflows. A cloner configures their copy (deposit address, payee API,
 * recipients, amounts) and enables it.
 *
 * Idempotent, matching the onboarding seeder:
 *   - Insert when the stable id is absent.
 *   - Refresh when the seeder last touched the row (seededAt ~ updatedAt).
 *   - Skip when the user has edited it since (updatedAt diverges from seededAt).
 *
 * Standalone usage:
 *   pnpm tsx scripts/seed/seed-tempo-templates.ts [--user=<email>]
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { member, users, workflows } from "../../lib/db/schema";
import { TEMPO_TEMPLATE_FIXTURES } from "./fixtures/tempo-templates";

/** Gap in ms between seededAt and updatedAt that indicates a user edit. */
const USER_EDIT_EPSILON_MS = 5_000;

type Identity = { userId: string; orgId: string };
type SeedResult = { created: number; refreshed: number; skipped: number };

export async function seedTempoTemplates(
  db: ReturnType<typeof drizzle>,
  identity: Identity
): Promise<SeedResult> {
  const result: SeedResult = { created: 0, refreshed: 0, skipped: 0 };
  const now = new Date();

  for (const fixture of TEMPO_TEMPLATE_FIXTURES) {
    const base = {
      name: fixture.name,
      description: fixture.description,
      userId: identity.userId,
      organizationId: identity.orgId,
      nodes: fixture.nodes,
      edges: fixture.edges,
      visibility: "public" as const,
      enabled: false,
      featured: false,
      isListed: true,
      listedSlug: fixture.listedSlug,
      listedAt: now,
      inputSchema: fixture.inputSchema,
      priceUsdcPerCall: "0",
      category: fixture.category,
      chain: fixture.chain,
      seededAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const existing = await db
      .select({
        id: workflows.id,
        updatedAt: workflows.updatedAt,
        seededAt: workflows.seededAt,
      })
      .from(workflows)
      .where(eq(workflows.id, fixture.id))
      .limit(1);

    if (!existing[0]) {
      await db
        .insert(workflows)
        .values({ id: fixture.id, createdAt: now, ...base });
      result.created++;
      continue;
    }

    const row = existing[0];
    const updatedMs = row.updatedAt?.getTime() ?? 0;
    const seededMs = row.seededAt?.getTime() ?? 0;
    const userEdited =
      row.seededAt === null || updatedMs - seededMs > USER_EDIT_EPSILON_MS;
    if (userEdited) {
      result.skipped++;
      continue;
    }

    await db.update(workflows).set(base).where(eq(workflows.id, fixture.id));
    result.refreshed++;
  }

  return result;
}

async function resolveIdentity(
  db: ReturnType<typeof drizzle>,
  email: string
): Promise<Identity | null> {
  const userRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!userRow[0]) {
    // biome-ignore lint/suspicious/noConsole: seed script CLI output
    console.log(`User not found: ${email} -- skipping Tempo template seed`);
    return null;
  }
  const memberRow = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userRow[0].id))
    .limit(1);
  if (!memberRow[0]) {
    // biome-ignore lint/suspicious/noConsole: seed script CLI output
    console.log(`User ${email} has no organization -- skipping`);
    return null;
  }
  return { userId: userRow[0].id, orgId: memberRow[0].organizationId };
}

async function main(): Promise<void> {
  const emailArg = process.argv
    .slice(2)
    .find((a) => a.startsWith("--user="))
    ?.split("=")[1];
  const email = emailArg ?? process.env.SEED_EMAIL ?? "dev@keeperhub.local";

  const client = postgres(getDatabaseUrl(), { max: 1 });
  const db = drizzle(client);
  try {
    const identity = await resolveIdentity(db, email);
    if (!identity) {
      return;
    }
    const result = await seedTempoTemplates(db, identity);
    // biome-ignore lint/suspicious/noConsole: seed script CLI output
    console.log(
      `Tempo templates -> org ${identity.orgId}: created ${result.created}, refreshed ${result.refreshed}, skipped ${result.skipped}`
    );
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("seed-tempo-templates.ts") ||
    process.argv[1].endsWith("seed-tempo-templates.js"));

if (isMain) {
  main().catch((err: unknown) => {
    // biome-ignore lint/suspicious/noConsole: seed script CLI output
    console.error(err);
    process.exit(1);
  });
}
