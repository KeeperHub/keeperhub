/**
 * One-shot backfill: ensure every active organization EOA wallet has a provisioned Solana address.
 * Pre-existing organization wallets created before migration 0128 have a NULL solana_address.
 * This script calls Turnkey's createWalletAccounts to add a Solana account and updates the DB.
 *
 * Usage:
 *   npx tsx scripts/backfill-solana-address.ts          # dry-run
 *   npx tsx scripts/backfill-solana-address.ts --apply  # apply changes
 */

import { isNull, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../lib/db/schema";
import { ensureOrganizationSolanaAddress } from "../lib/turnkey/ensure-solana-address";
import { isSolanaWalletProvisioningEnabled } from "../lib/turnkey/solana-provisioning-flag";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

if (
  !(
    process.env.TURNKEY_API_PUBLIC_KEY &&
    process.env.TURNKEY_API_PRIVATE_KEY &&
    process.env.TURNKEY_ORGANIZATION_ID
  )
) {
  console.error(
    "TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID must be set"
  );
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });
const dryRun = !process.argv.includes("--apply");

async function main(): Promise<void> {
  if (!isSolanaWalletProvisioningEnabled()) {
    console.log(
      'Solana wallet provisioning is disabled (SOLANA_WALLET_PROVISIONING_ENABLED != "true"). Nothing to do.'
    );
    await client.end();
    return;
  }

  if (dryRun) {
    console.log("[DRY RUN] No changes will be written.\n");
  }

  const wallets = await db
    .select()
    .from(schema.organizationWallets)
    .where(
      and(
        isNull(schema.organizationWallets.solanaAddress),
        eq(schema.organizationWallets.isActive, true)
      )
    );

  console.log(`Found ${wallets.length} active wallet(s) missing Solana address.\n`);

  if (wallets.length === 0) {
    await client.end();
    return;
  }

  let applied = 0;
  let failed = 0;

  for (const w of wallets) {
    if (!(w.turnkeySubOrgId && w.turnkeyWalletId)) {
      console.warn(
        `Skipping wallet ${w.id} (organization ${w.organizationId}): missing turnkeySubOrgId or turnkeyWalletId`
      );
      failed++;
      continue;
    }

    if (dryRun) {
      console.log(
        `[DRY RUN] Would provision Solana account for sub-org ${w.turnkeySubOrgId}, wallet ${w.turnkeyWalletId} (DB Row ID: ${w.id})`
      );
      continue;
    }

    try {
      const solanaAddress = await ensureOrganizationSolanaAddress(w);
      console.log(
        `Updated DB row ${w.id} with Solana address ${solanaAddress}.`
      );
      applied++;
    } catch (error) {
      console.error(
        `Failed to provision Solana account for wallet ${w.id} (subOrgId: ${w.turnkeySubOrgId}):`,
        error instanceof Error ? error.message : error
      );
      failed++;
    }
  }

  console.log("\nSummary:");
  console.log(`- Applied: ${applied}`);
  console.log(`- Failed: ${failed}`);
  if (dryRun) {
    console.log("\nRe-run with --apply to write changes.");
  }

  await client.end();
}

main()
  .then(() => {
    // ensureOrganizationSolanaAddress pulls in @/lib/db, whose connection pools
    // are module-scoped and never closed by this script - only the local client
    // above is. Those pools hold open sockets with no idle timeout, so the
    // process would otherwise sit there after the summary prints.
    process.exit(0);
  })
  .catch((error) => {
    console.error("Backfill script execution failed:", error);
    process.exit(1);
  });
