/**
 * Quick fix for USDS logo URL
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { supportedTokens } from "@/lib/db/schema-extensions";

const CORRECT_USDS_LOGO =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdC035D45d973E3EC169d2276DDab16f1e407384F/logo.png";

async function fix() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  console.log("Before update:");
  const before = await db
    .select({
      symbol: supportedTokens.symbol,
      logoUrl: supportedTokens.logoUrl,
    })
    .from(supportedTokens)
    .where(eq(supportedTokens.symbol, "USDS"));
  console.log(before);

  console.log("\nUpdating USDS logos...");
  await db
    .update(supportedTokens)
    .set({ logoUrl: CORRECT_USDS_LOGO })
    .where(eq(supportedTokens.symbol, "USDS"));

  console.log("\nAfter update:");
  const after = await db
    .select({
      symbol: supportedTokens.symbol,
      logoUrl: supportedTokens.logoUrl,
    })
    .from(supportedTokens)
    .where(eq(supportedTokens.symbol, "USDS"));
  console.log(after);

  await client.end();
}

fix().catch(console.error);
