/**
 * Seed script for supported tokens (stablecoins)
 *
 * This script populates the supported_tokens table with default stablecoins
 * for each supported chain. Token metadata (symbol, name, decimals) is fetched
 * directly from the blockchain to ensure accuracy.
 *
 * RPC URL resolution priority:
 *   1. CHAIN_RPC_CONFIG JSON (for Helm/AWS Parameter Store)
 *   2. Individual env vars (CHAIN_ETH_MAINNET_PRIMARY_RPC, etc.)
 *   3. Public RPC defaults (no API keys required)
 *
 * Run with: pnpm tsx scripts/seed/seed-tokens.ts
 */

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { ethers } from "ethers";
import postgres from "postgres";
import { supportedTokens } from "@/lib/db/schema-extensions";
import ERC20_ABI from "../../lib/contracts/abis/erc20.json";
import { getDatabaseUrl } from "../../lib/db/connection-utils";
import { getRpcUrlByChainId } from "../../lib/rpc/rpc-config";
import { formatSanitizedRpcError } from "../../lib/rpc/sanitize-rpc-error";
import { TOKEN_CONFIGS } from "./supported-token-configs";

/**
 * Fetch ERC-20 metadata via a single provider.
 * Throws on any RPC or contract-call failure.
 */
async function fetchWithProvider(
  rpcUrl: string,
  tokenAddress: string
): Promise<{ symbol: string; name: string; decimals: number }> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [symbol, name, decimals] = await Promise.all([
    contract.symbol() as Promise<string>,
    contract.name() as Promise<string>,
    contract.decimals() as Promise<bigint>,
  ]);

  return { symbol, name, decimals: Number(decimals) };
}

/**
 * Fetch token metadata from the blockchain.
 * Tries primary RPC first, falls back to the fallback URL on failure.
 */
async function fetchTokenMetadata(
  chainId: number,
  tokenAddress: string
): Promise<{ symbol: string; name: string; decimals: number }> {
  const primaryUrl = getRpcUrlByChainId(chainId, "primary");

  try {
    return await fetchWithProvider(primaryUrl, tokenAddress);
  } catch (primaryError) {
    const fallbackUrl = getRpcUrlByChainId(chainId, "fallback");
    if (fallbackUrl === primaryUrl) {
      throw primaryError;
    }

    console.warn(
      `  Primary RPC failed, trying fallback for chain ${chainId}...`
    );
    return await fetchWithProvider(fallbackUrl, tokenAddress);
  }
}

async function seedTokens() {
  const connectionString = getDatabaseUrl();

  console.log("Connecting to database...");
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  console.log(`Seeding ${TOKEN_CONFIGS.length} supported tokens...\n`);

  for (const config of TOKEN_CONFIGS) {
    try {
      // Fetch token metadata from blockchain
      console.log(
        `Fetching metadata for ${config.tokenAddress} on chain ${config.chainId}...`
      );
      const metadata = await fetchTokenMetadata(
        config.chainId,
        config.tokenAddress
      );
      console.log(`  Found: ${metadata.symbol} (${metadata.name})`);

      const tokenData = {
        chainId: config.chainId,
        tokenAddress: config.tokenAddress,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        logoUrl: config.logoUrl,
        isStablecoin: config.isStablecoin,
        sortOrder: config.sortOrder,
      };

      // Check if token already exists for this chain
      const existing = await db
        .select()
        .from(supportedTokens)
        .where(
          and(
            eq(supportedTokens.chainId, config.chainId),
            eq(supportedTokens.tokenAddress, config.tokenAddress)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Update existing token
        await db
          .update(supportedTokens)
          .set({
            symbol: tokenData.symbol,
            name: tokenData.name,
            decimals: tokenData.decimals,
            logoUrl: tokenData.logoUrl,
            isStablecoin: tokenData.isStablecoin,
            sortOrder: tokenData.sortOrder,
          })
          .where(
            and(
              eq(supportedTokens.chainId, config.chainId),
              eq(supportedTokens.tokenAddress, config.tokenAddress)
            )
          );
        console.log("  ~ Updated in database\n");
      } else {
        // Insert new token
        await db.insert(supportedTokens).values(tokenData);
        console.log("  + Inserted into database\n");
      }
    } catch (error) {
      console.error(
        `  ✗ Failed to process ${config.tokenAddress} on chain ${config.chainId}:`,
        formatSanitizedRpcError(error)
      );
      console.log("");
    }
  }

  console.log("Done!");
  await client.end();
  process.exit(0);
}

seedTokens().catch((err) => {
  console.error("Error seeding tokens:", formatSanitizedRpcError(err));
  process.exit(1);
});
