#!/usr/bin/env tsx

/**
 * verify-token.ts
 *
 * Verifies an ERC-20 token contract on a given chain by calling `symbol()`,
 * `name()`, and `decimals()` via the chain's configured primary RPC (with
 * fallback on failure). Prints a row compatible with the `TOKEN_CONFIGS`
 * format in `scripts/seed/seed-tokens.ts`.
 *
 * Exits 1 if any metadata call reverts, times out, or the response is not
 * a valid ERC-20 shape.
 *
 * Usage:
 *   pnpm tsx scripts/verify-token.ts <chainId> <tokenAddress>
 *
 * Example:
 *   pnpm tsx scripts/verify-token.ts 43114 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E
 */

import "dotenv/config";
import { ethers } from "ethers";
import ERC20_ABI from "../lib/contracts/abis/erc20.json";
import { getRpcUrlByChainId } from "../lib/rpc/rpc-config";
import { formatSanitizedRpcError } from "../lib/rpc/sanitize-rpc-error";

type TokenMetadata = {
  symbol: string;
  name: string;
  decimals: number;
};

async function fetchMetadata(
  rpcUrl: string,
  tokenAddress: string
): Promise<TokenMetadata> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [symbol, name, decimals] = await Promise.all([
    contract.symbol() as Promise<string>,
    contract.name() as Promise<string>,
    contract.decimals() as Promise<bigint>,
  ]);

  return { symbol, name, decimals: Number(decimals) };
}

async function main(): Promise<void> {
  const [chainIdArg, tokenAddress] = process.argv.slice(2);

  if (!(chainIdArg && tokenAddress)) {
    console.error("Usage: pnpm tsx scripts/verify-token.ts <chainId> <tokenAddress>");
    process.exit(1);
  }

  const chainId = Number.parseInt(chainIdArg, 10);
  if (!Number.isFinite(chainId)) {
    console.error(`Invalid chainId: ${chainIdArg}`);
    process.exit(1);
  }

  if (!ethers.isAddress(tokenAddress)) {
    console.error(`Invalid address: ${tokenAddress}`);
    process.exit(1);
  }

  const lower = tokenAddress.toLowerCase();
  const primaryUrl = getRpcUrlByChainId(chainId, "primary");

  console.log(`Verifying ${lower} on chain ${chainId}`);
  console.log(`  primary RPC: ${primaryUrl}`);

  let metadata: TokenMetadata;
  try {
    metadata = await fetchMetadata(primaryUrl, lower);
  } catch (primaryError) {
    const fallbackUrl = getRpcUrlByChainId(chainId, "fallback");
    if (fallbackUrl === primaryUrl) {
      console.error(
        `  primary RPC failed and no distinct fallback is configured: ${formatSanitizedRpcError(primaryError)}`
      );
      process.exit(1);
    }
    console.warn(
      `  primary RPC failed, trying fallback: ${fallbackUrl}`
    );
    try {
      metadata = await fetchMetadata(fallbackUrl, lower);
    } catch (fallbackError) {
      console.error(
        `  fallback RPC also failed: ${formatSanitizedRpcError(fallbackError)}`
      );
      process.exit(1);
    }
  }

  console.log("");
  console.log(`  symbol:   ${metadata.symbol}`);
  console.log(`  name:     ${metadata.name}`);
  console.log(`  decimals: ${metadata.decimals}`);
  console.log("");
  console.log("TOKEN_CONFIGS entry:");
  console.log("");
  console.log("  {");
  console.log(`    chainId: ${chainId},`);
  console.log(`    tokenAddress: "${lower}", // ${metadata.symbol}`);
  console.log(`    logoUrl: LOGOS.${metadata.symbol} ?? null,`);
  console.log("    isStablecoin: true,");
  console.log("    sortOrder: 1,");
  console.log("  },");

  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
