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

// Token logo URLs (using popular token list sources)
const LOGOS = {
  USDC: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png",
  USDT: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
  USDS: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdC035D45d973E3EC169d2276DDab16f1e407384F/logo.png",
};

/**
 * Token configuration - only addresses and metadata that can't be fetched
 */
type TokenConfig = {
  chainId: number;
  tokenAddress: string;
  logoUrl: string | null;
  isStablecoin: boolean;
  sortOrder: number;
};

const TOKEN_CONFIGS: TokenConfig[] = [
  // ==========================================================================
  // Ethereum Mainnet (chainId: 1)
  // ==========================================================================
  {
    chainId: 1,
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 1,
    tokenAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    logoUrl: LOGOS.USDT,
    isStablecoin: true,
    sortOrder: 2,
  },
  {
    chainId: 1,
    tokenAddress: "0xdc035d45d973e3ec169d2276ddab16f1e407384f", // USDS (Sky/MakerDAO)
    logoUrl: LOGOS.USDS,
    isStablecoin: true,
    sortOrder: 3,
  },

  // ==========================================================================
  // Sepolia Testnet (chainId: 11155111)
  // ==========================================================================
  {
    chainId: 11_155_111,
    tokenAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", // USDC (Circle's official Sepolia)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 11_155_111,
    tokenAddress: "0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0", // USDT (Aave's Sepolia)
    logoUrl: LOGOS.USDT,
    isStablecoin: true,
    sortOrder: 2,
  },
  // Note: USDS not yet deployed on Sepolia

  // ==========================================================================
  // Base Mainnet (chainId: 8453)
  // ==========================================================================
  {
    chainId: 8453,
    tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC (native)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 8453,
    tokenAddress: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC (bridged)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 2,
  },
  {
    chainId: 8453,
    tokenAddress: "0x820c137fa70c8691f0e44dc420a5e53c168921dc", // USDS (Sky/MakerDAO)
    logoUrl: LOGOS.USDS,
    isStablecoin: true,
    sortOrder: 3,
  },

  // ==========================================================================
  // Base Sepolia (chainId: 84532)
  // ==========================================================================
  {
    chainId: 84_532,
    tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // USDC (Circle's official Base Sepolia)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },

  // ==========================================================================
  // Tempo Testnet (chainId: 42431)
  // ==========================================================================
  {
    chainId: 42_431,
    tokenAddress: "0x20c0000000000000000000000000000000000000", // pathUSD
    logoUrl: null, // Tempo testnet token
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 42_431,
    tokenAddress: "0x20c0000000000000000000000000000000000001", // AlphaUSD
    logoUrl: null, // Tempo testnet token
    isStablecoin: true,
    sortOrder: 2,
  },
  {
    chainId: 42_431,
    tokenAddress: "0x20c0000000000000000000000000000000000002", // BetaUSD
    logoUrl: null, // Tempo testnet token
    isStablecoin: true,
    sortOrder: 3,
  },
  {
    chainId: 42_431,
    tokenAddress: "0x20c0000000000000000000000000000000000003", // ThetaUSD
    logoUrl: null, // Tempo testnet token
    isStablecoin: true,
    sortOrder: 4,
  },

  // ==========================================================================
  // BNB Chain Mainnet (chainId: 56)
  // ==========================================================================
  {
    chainId: 56,
    tokenAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC (Binance-Peg)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 56,
    tokenAddress: "0x55d398326f99059ff775485246999027b3197955", // USDT (Binance-Peg)
    logoUrl: LOGOS.USDT,
    isStablecoin: true,
    sortOrder: 2,
  },

  // ==========================================================================
  // Polygon Mainnet (chainId: 137)
  // ==========================================================================
  {
    chainId: 137,
    tokenAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC (native)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },

  // ==========================================================================
  // Polygon Amoy Testnet (chainId: 80002)
  // ==========================================================================
  {
    chainId: 80_002,
    tokenAddress: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582", // USDC (Circle testnet)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },

  // ==========================================================================
  // Arbitrum One (chainId: 42161)
  // ==========================================================================
  {
    chainId: 42_161,
    tokenAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC (native)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 42_161,
    tokenAddress: "0x6491c05a82219b8d1479057361ff1654749b876b", // USDS (Sky/MakerDAO via SkyLink)
    logoUrl: LOGOS.USDS,
    isStablecoin: true,
    sortOrder: 2,
  },

  // ==========================================================================
  // Arbitrum Sepolia (chainId: 421614)
  // ==========================================================================
  {
    chainId: 421_614,
    tokenAddress: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", // USDC (Circle testnet)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },

  // ==========================================================================
  // Tempo Mainnet (chainId: 4217)
  // ==========================================================================
  {
    chainId: 4217,
    tokenAddress: "0x20c000000000000000000000b9537d11c60e8b50", // USDC.e (Bridged USDC via Stargate)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 4217,
    tokenAddress: "0x20c00000000000000000000014f22ca97301eb73", // USDT0
    logoUrl: LOGOS.USDT,
    isStablecoin: true,
    sortOrder: 2,
  },
  {
    chainId: 4217,
    tokenAddress: "0x20c0000000000000000000003554d28269e0f3c2", // frxUSD (Frax USD)
    logoUrl: null,
    isStablecoin: true,
    sortOrder: 3,
  },

  // ==========================================================================
  // Avalanche C-Chain (chainId: 43114)
  // ==========================================================================
  {
    chainId: 43_114,
    tokenAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // USDC (Circle native)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },
  {
    chainId: 43_114,
    tokenAddress: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", // USDt (Tether native, symbol is lowercase 't')
    logoUrl: LOGOS.USDT,
    isStablecoin: true,
    sortOrder: 2,
  },

  // ==========================================================================
  // Avalanche Fuji Testnet (chainId: 43113)
  // ==========================================================================
  {
    chainId: 43_113,
    tokenAddress: "0x5425890298aed601595a70ab815c96711a31bc65", // USDC (Circle testnet)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },

  // ==========================================================================
  // 0G Mainnet (chainId: 16661)
  // ==========================================================================
  // Only XSwap-bridged USDC.e is tracked: Circle has not deployed native USDC
  // on 0G, and no other stablecoin issuer has deployed natively. Bridged via
  // Chainlink CCIP from Ethereum. Galileo testnet has no canonical bridged
  // USDC (CCIP is decommissioned on Galileo), so no testnet entry.
  {
    chainId: 16_661,
    tokenAddress: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e", // USDC.e (XSwap Bridged USDC via Chainlink CCIP)
    logoUrl: LOGOS.USDC,
    isStablecoin: true,
    sortOrder: 1,
  },

  // ==========================================================================
  // Plasma Mainnet (chainId: 9745)
  // ==========================================================================
  // Only USDT0 is tracked: Circle has not deployed native USDC on Plasma, and
  // Sky's USDS has not been deployed on Plasma. Add new stablecoins here once
  // issuers deploy natively.
  {
    chainId: 9745,
    tokenAddress: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", // USDT0 (Tether omnichain via LayerZero)
    logoUrl: LOGOS.USDT,
    isStablecoin: true,
    sortOrder: 1,
  },
];

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
