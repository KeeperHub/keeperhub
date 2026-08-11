#!/usr/bin/env tsx

/**
 * Seed the six onboarding hub workflows into the database (KEEP-171).
 *
 * Each workflow gets `visibility: "public"`, `featured: true`, and a
 * `listedSlug` matching the chip id in getting-started-config.ts. The
 * recommendations endpoint (`/api/onboarding/recommendations`) queries by
 * those slugs and returns the live workflow ids, replacing the six
 * NEXT_PUBLIC_ONBOARDING_WF_* build-time env vars.
 *
 * Idempotent:
 *   - If a row with the given id does not exist, it is inserted.
 *   - If it exists and the seeder last touched it (`seededAt` within epsilon of
 *     `updatedAt`), it is refreshed so fixture updates land on re-run.
 *   - If the user has edited the workflow (updatedAt diverges from seededAt),
 *     the seed is skipped to preserve their changes.
 *
 * Standalone usage:
 *   pnpm db:seed-onboarding [--user=<email>]
 *
 * The `--user` flag controls which user's org receives the workflows.
 * Defaults to SEED_EMAIL or "dev@keeperhub.local".
 *
 * Also exported as `seedOnboardingWorkflows(db, identity)` for use from
 * dev-bootstrap.ts.
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { member, users, workflows } from "../../lib/db/schema";
import {
  ONBOARDING_WORKFLOW_FIXTURES,
  type OnboardingWorkflowFixture,
} from "./fixtures/onboarding-workflows";

/** Gap in ms between seededAt and updatedAt that indicates a user edit. */
export const USER_EDIT_EPSILON_MS = 5_000;

type Identity = { userId: string; orgId: string };

type SeedResult = { created: number; refreshed: number; skipped: number };

export async function seedOnboardingWorkflows(
  db: ReturnType<typeof drizzle>,
  identity: Identity
): Promise<SeedResult> {
  const result: SeedResult = { created: 0, refreshed: 0, skipped: 0 };
  const now = new Date();

  for (const fixture of ONBOARDING_WORKFLOW_FIXTURES) {
    const existing = await db
      .select({
        id: workflows.id,
        updatedAt: workflows.updatedAt,
        seededAt: workflows.seededAt,
        deletedAt: workflows.deletedAt,
      })
      .from(workflows)
      .where(eq(workflows.id, fixture.id))
      .limit(1);

    if (!existing[0]) {
      await db.insert(workflows).values({
        id: fixture.id,
        name: fixture.name,
        description: fixture.description,
        userId: identity.userId,
        organizationId: identity.orgId,
        nodes: fixture.nodes,
        edges: fixture.edges,
        visibility: "public",
        enabled: true,
        featured: true,
        featuredProtocol: fixture.featuredProtocol,
        listedSlug: fixture.listedSlug,
        seededAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      result.created++;
      continue;
    }

    const row = existing[0];
    const updatedMs = row.updatedAt?.getTime() ?? 0;
    const seededMs = row.seededAt?.getTime() ?? 0;
    // seededAt=null means the row was not seeded by this script — skip.
    // seededAt set but updatedAt diverges by more than epsilon means the user
    // has edited the workflow since we last seeded it — skip.
    const userEdited =
      row.seededAt === null || updatedMs - seededMs > USER_EDIT_EPSILON_MS;

    if (userEdited) {
      result.skipped++;
      continue;
    }

    await db
      .update(workflows)
      .set({
        name: fixture.name,
        description: fixture.description,
        userId: identity.userId,
        organizationId: identity.orgId,
        nodes: fixture.nodes,
        edges: fixture.edges,
        visibility: "public",
        enabled: true,
        featured: true,
        featuredProtocol: fixture.featuredProtocol,
        listedSlug: fixture.listedSlug,
        seededAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .where(eq(workflows.id, fixture.id));
    result.refreshed++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

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
    console.log(`User not found: ${email} -- skipping onboarding seed`);
    return null;
  }

  const userId = userRow[0].id;

  const memberRow = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);

  if (!memberRow[0]) {
    console.log(`User ${email} has no organization membership -- skipping onboarding seed`);
    return null;
  }

  return { userId, orgId: memberRow[0].organizationId };
}

async function main(): Promise<void> {
  const emailArg = process.argv
    .slice(2)
    .find((a) => a.startsWith("--user="))
    ?.split("=")[1];
  const email =
    emailArg ?? process.env.SEED_EMAIL ?? "dev@keeperhub.local";

  const url = getDatabaseUrl();
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    const identity = await resolveIdentity(db, email);
    if (!identity) {
      return;
    }
    console.log(`Seeding onboarding workflows into org ${identity.orgId} (user ${email})`);

    const result = await seedOnboardingWorkflows(db, identity);
    console.log(
      `  created: ${result.created}  refreshed: ${result.refreshed}  skipped (user-edited): ${result.skipped}`
    );
    console.log(`  total fixtures: ${ONBOARDING_WORKFLOW_FIXTURES.length}`);
  } finally {
    await client.end();
  }
}

// Main-guard so `import { USER_EDIT_EPSILON_MS } from ...` in tests/unit
// doesn't fire main() at module load (which would try to connect to PG and
// throw an unhandled rejection in the unit test pool).
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("seed-onboarding-workflows.ts") ||
    process.argv[1].endsWith("seed-onboarding-workflows.js"));

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
