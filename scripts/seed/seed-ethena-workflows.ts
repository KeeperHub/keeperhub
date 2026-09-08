/**
 * Seed script for Ethena sUSDe vault test workflows.
 * Creates read and write test workflows for Ethena protocol actions.
 *
 * Usage: pnpm tsx scripts/seed/seed-ethena-workflows.ts
 */

import "dotenv/config";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { member, users, workflows } from "../../lib/db/schema";
import { generateId } from "../../lib/utils/id";

const connectionString = getDatabaseUrl();
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

const DEV_EMAIL = process.env.SEED_EMAIL ?? "dev@keeperhub.local";

function loadWorkflow(filename: string): { nodes: unknown[]; edges: unknown[] } {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const filepath = resolve(__dirname, "workflows/ethena", filename);
  const raw = readFileSync(filepath, "utf-8");
  const data = JSON.parse(raw) as { nodes: unknown[]; edges: unknown[] };
  return { nodes: data.nodes, edges: data.edges };
}

async function seed(): Promise<void> {
  console.log("Seeding Ethena sUSDe vault test workflows...\n");

  const now = new Date();

  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEV_EMAIL))
    .limit(1);

  if (!existingUser[0]) {
    console.error(
      `User "${DEV_EMAIL}" not found. Run seed-user.ts first, or set SEED_EMAIL.`
    );
    process.exit(1);
  }

  const userId = existingUser[0].id;
  console.log(`  + User: ${DEV_EMAIL} (${userId})`);

  const existingMember = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);

  if (!existingMember[0]) {
    console.error(
      `User "${DEV_EMAIL}" has no organization. Sign in via the UI first.`
    );
    process.exit(1);
  }

  const orgId = existingMember[0].organizationId;
  console.log(`  + Organization: ${orgId}\n`);

  const readWf = loadWorkflow("read-actions.json");
  const writeWf = loadWorkflow("write-actions.json");

  const defs = [
    {
      name: "Protocol Test: Ethena Read Actions",
      description:
        "Tests all 14 Ethena read actions (ERC-4626 vault, cooldown, token balances) on Ethereum mainnet",
      ...readWf,
    },
    {
      name: "Protocol Test: Ethena Write Actions",
      description:
        "Tests all 7 Ethena write actions (vault deposit/withdraw/redeem, cooldown, approve) on Ethereum mainnet",
      ...writeWf,
    },
  ];

  const createdIds: string[] = [];

  for (const def of defs) {
    const id = generateId();
    await db
      .insert(workflows)
      .values({
        id,
        name: def.name,
        description: def.description,
        userId,
        organizationId: orgId,
        nodes: def.nodes,
        edges: def.edges,
        visibility: "private",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    createdIds.push(id);
    console.log(`  + ${def.name}`);
    console.log(`    ID: ${id}`);
    console.log(`    http://localhost:3000/workflows/${id}`);
  }

  console.log(
    `\nDone! Created ${createdIds.length} Ethena test workflows.`
  );

  await client.end();
  process.exit(0);
}

seed().catch(async (err: unknown) => {
  console.error("Seed failed:", err);
  await client.end();
  process.exit(1);
});
