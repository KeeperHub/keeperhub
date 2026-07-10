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
import { Turnkey } from "@turnkey/sdk-server";
import * as schema from "../lib/db/schema";

const connectionString = process.env.DATABASE_URL;
const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
const turnkeyOrgId = process.env.TURNKEY_ORGANIZATION_ID;

if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

if (!(apiPublicKey && apiPrivateKey && turnkeyOrgId)) {
  console.error(
    "TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID must be set"
  );
  process.exit(1);
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });
const dryRun = !process.argv.includes("--apply");

const turnkey = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey,
  apiPrivateKey,
  defaultOrganizationId: turnkeyOrgId,
});

async function main(): Promise<void> {
  if (dryRun) {
    console.log("[DRY RUN] No changes will be written.\n");
  }

  // Find active wallets missing a Solana address that have valid Turnkey IDs
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
    const subOrgId = w.turnkeySubOrgId;
    const walletId = w.turnkeyWalletId;

    if (!subOrgId || !walletId) {
      console.warn(`Skipping wallet ${w.id} (organization ${w.organizationId}): missing turnkeySubOrgId or turnkeyWalletId`);
      failed++;
      continue;
    }

    if (dryRun) {
      console.log(`[DRY RUN] Would provision Solana account for sub-org ${subOrgId}, wallet ${walletId} (DB Row ID: ${w.id})`);
      continue;
    }

    try {
      console.log(`Provisioning Solana account for sub-org ${subOrgId}...`);
      
      const turnkeyClient = turnkey.apiClient();
      const result = await turnkeyClient.createWalletAccounts({
        organizationId: subOrgId,
        walletId: walletId,
        accounts: [
          {
            curve: "CURVE_ED25519",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/501'/0'/0'",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
      });

      const solanaAddress = result.addresses?.[0];
      if (!solanaAddress) {
        throw new Error("No addresses returned from Turnkey createWalletAccounts");
      }

      console.log(`Successfully provisioned Solana address: ${solanaAddress}. Updating DB row ${w.id}...`);

      await db
        .update(schema.organizationWallets)
        .set({ solanaAddress })
        .where(eq(schema.organizationWallets.id, w.id));

      applied++;
    } catch (error) {
      console.error(
        `Failed to provision Solana account for wallet ${w.id} (subOrgId: ${subOrgId}):`,
        error instanceof Error ? error.message : error
      );
      failed++;
    }
  }

  console.log(`\nSummary:`);
  console.log(`- Applied: ${applied}`);
  console.log(`- Failed: ${failed}`);
  if (dryRun) {
    console.log("\nRe-run with --apply to write changes.");
  }

  await client.end();
}

main().catch((error) => {
  console.error("Backfill script execution failed:", error);
  process.exit(1);
});
