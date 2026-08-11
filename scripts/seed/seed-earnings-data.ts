/**
 * Seed script for testing the Earnings dashboard (Phase 30).
 * Creates payment records for the listed workflows seeded by seed-listing-workflows.ts.
 *
 * Usage: pnpm tsx scripts/seed/seed-earnings-data.ts
 *
 * Prerequisites: Run seed-listing-workflows.ts first (needs listed workflows in DB).
 */

import "dotenv/config";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { workflows } from "../../lib/db/schema";
import { workflowPayments } from "../../lib/db/schema-payments";
import { generateId } from "../../lib/utils/id";

const connectionString = getDatabaseUrl();
const client = postgres(connectionString, { max: 1 });
const db = drizzle(client);

const PAYER_ADDRESSES = [
  "0x1234567890abcdef1234567890abcdef12345678",
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "0x9876543210fedcba9876543210fedcba98765432",
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  "0xcafebabecafebabecafebabecafebabecafebabe",
];

async function seed(): Promise<void> {
  console.log("Seeding earnings test data...\n");

  const listedRows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      listedSlug: workflows.listedSlug,
      priceUsdcPerCall: workflows.priceUsdcPerCall,
      organizationId: workflows.organizationId,
    })
    .from(workflows)
    .where(eq(workflows.isListed, true));

  if (listedRows.length === 0) {
    console.error(
      "No listed workflows found. Run seed-listing-workflows.ts first."
    );
    process.exit(1);
  }

  console.log(`  Found ${listedRows.length} listed workflow(s)\n`);

  let totalPayments = 0;

  for (const wf of listedRows) {
    const price = Number(wf.priceUsdcPerCall ?? "0");
    const paymentCount = price > 0 ? 15 + Math.floor(Math.random() * 20) : 8;

    console.log(
      `  ${wf.name} (${wf.listedSlug}): ${paymentCount} payments @ $${price}/call`
    );

    for (let i = 0; i < paymentCount; i++) {
      const payerIdx = Math.floor(Math.random() * PAYER_ADDRESSES.length);
      const daysAgo = Math.floor(Math.random() * 30);
      const settledAt = new Date(Date.now() - daysAgo * 86400000);

      await db
        .insert(workflowPayments)
        .values({
          workflowId: wf.id,
          paymentHash: generateId(),
          executionId: generateId(),
          amountUsdc: String(price),
          payerAddress: PAYER_ADDRESSES[payerIdx],
          creatorWalletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
          settledAt,
        })
        .onConflictDoNothing();
    }

    totalPayments += paymentCount;
  }

  console.log(`\nDone! Created ${totalPayments} payment records.`);
  console.log("Navigate to /earnings to see the dashboard.");

  await client.end();
  process.exit(0);
}

seed().catch(async (err: unknown) => {
  console.error("Seed failed:", err);
  await client.end();
  process.exit(1);
});
