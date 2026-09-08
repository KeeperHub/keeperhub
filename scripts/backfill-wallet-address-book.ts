/**
 * One-shot backfill: ensure every org's Turnkey/Para EOA and Safe wallets
 * appear in their address book. Idempotent via the unique
 * (organization_id, address) index introduced in migration 0079.
 *
 * Usage:
 *   npx tsx scripts/backfill-wallet-address-book.ts          # dry-run
 *   npx tsx scripts/backfill-wallet-address-book.ts --apply  # apply changes
 */

import { isNotNull } from "drizzle-orm";
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

type Candidate = {
  organizationId: string;
  address: string;
  label: string;
  createdBy: string | null;
};

async function main(): Promise<void> {
  if (dryRun) {
    console.log("[DRY RUN] No changes will be written.\n");
  }

  // Legacy `organization_wallets` rows can have a null organization_id
  // (pre-org schema migration); skip those - no org means no address book.
  const orgWallets = await db
    .select({
      organizationId: schema.organizationWallets.organizationId,
      address: schema.organizationWallets.walletAddress,
      userId: schema.organizationWallets.userId,
    })
    .from(schema.organizationWallets)
    .where(isNotNull(schema.organizationWallets.organizationId));

  const safes = await db
    .select({
      organizationId: schema.safeWallets.organizationId,
      address: schema.safeWallets.safeAddress,
    })
    .from(schema.safeWallets);

  const candidates: Candidate[] = [
    ...orgWallets
      .filter((w): w is typeof w & { organizationId: string } =>
        w.organizationId !== null
      )
      .map((w) => ({
        organizationId: w.organizationId,
        address: w.address,
        label: "Org Wallet",
        createdBy: w.userId,
      })),
    ...safes.map((s) => ({
      organizationId: s.organizationId,
      address: s.address,
      label: "Safe Wallet",
      createdBy: null,
    })),
  ];

  console.log(
    `Found ${orgWallets.length} EOA wallet(s) and ${safes.length} Safe wallet(s). Total candidates: ${candidates.length}\n`
  );

  if (candidates.length === 0) {
    await client.end();
    return;
  }

  let inserted = 0;
  let skipped = 0;

  for (const c of candidates) {
    if (dryRun) {
      console.log(
        `  ${c.organizationId} <- ${c.address} (${c.label})`
      );
      continue;
    }

    const result = await db
      .insert(schema.addressBookEntry)
      .values({
        organizationId: c.organizationId,
        label: c.label,
        address: c.address,
        createdBy: c.createdBy,
      })
      .onConflictDoNothing({
        target: [
          schema.addressBookEntry.organizationId,
          schema.addressBookEntry.address,
        ],
      })
      .returning({ id: schema.addressBookEntry.id });

    if (result.length > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }

  if (!dryRun) {
    console.log(`\nInserted: ${inserted}, Skipped (already present): ${skipped}`);
  }

  if (dryRun && candidates.length > 0) {
    console.log("\nRe-run with --apply to write changes.");
  }

  await client.end();
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
