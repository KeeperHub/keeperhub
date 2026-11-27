/**
 * Quick test script for Solana provider
 *
 * RPC URL resolution priority:
 *   1. CHAIN_RPC_CONFIG JSON (for Helm/AWS Parameter Store)
 *   2. Individual env vars (CHAIN_SOLANA_MAINNET_PRIMARY_RPC, etc.)
 *   3. Public RPC defaults (no API keys required)
 *
 * Run with: pnpm tsx scripts/test-solana-provider.ts
 */

import "dotenv/config";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createSolanaProviderManager } from "../../lib/rpc/providers/solana";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "../../lib/rpc/rpc-config";
import { RPC_ENDPOINT } from "../../lib/rpc/rpc-endpoint";

// Parse JSON config from environment (if available)
const rpcConfig = parseRpcConfig(process.env.CHAIN_RPC_CONFIG);

// Create resolver function for this script
const getRpcUrl = createRpcUrlResolver(rpcConfig);

async function testSolanaProvider() {
  console.log("Testing Solana Provider...\n");

  // Test with mainnet (JSON config → env var → public RPC)
  const mainnetProvider = createSolanaProviderManager({
    primaryRpcUrl: getRpcUrl(
      "solana-mainnet",
      "CHAIN_SOLANA_MAINNET_PRIMARY_RPC",
      PUBLIC_RPCS.SOLANA_MAINNET,
      RPC_ENDPOINT.PRIMARY
    ),
    fallbackRpcUrl: getRpcUrl(
      "solana-mainnet",
      "CHAIN_SOLANA_MAINNET_FALLBACK_RPC",
      PUBLIC_RPCS.SOLANA_MAINNET,
      RPC_ENDPOINT.FALLBACK
    ),
    chainName: "Solana Mainnet",
  });

  // Test with devnet (JSON config → env var → public RPC)
  const devnetProvider = createSolanaProviderManager({
    primaryRpcUrl: getRpcUrl(
      "solana-devnet",
      "CHAIN_SOLANA_DEVNET_PRIMARY_RPC",
      PUBLIC_RPCS.SOLANA_DEVNET,
      RPC_ENDPOINT.PRIMARY
    ),
    fallbackRpcUrl: getRpcUrl(
      "solana-devnet",
      "CHAIN_SOLANA_DEVNET_FALLBACK_RPC",
      PUBLIC_RPCS.SOLANA_DEVNET,
      RPC_ENDPOINT.FALLBACK
    ),
    chainName: "Solana Devnet",
  });

  try {
    // Test mainnet - get slot
    console.log("=== Solana Mainnet ===");
    const mainnetSlot = await mainnetProvider.executeWithFailover(
      async (connection) => connection.getSlot()
    );
    console.log(`Current slot: ${mainnetSlot}`);

    // Get version
    const mainnetVersion = await mainnetProvider.executeWithFailover(
      async (connection) => connection.getVersion()
    );
    console.log(`Version: ${JSON.stringify(mainnetVersion)}`);

    console.log(
      `Using fallback: ${mainnetProvider.isCurrentlyUsingFallback()}`
    );
    console.log(`Metrics: ${JSON.stringify(mainnetProvider.getMetrics())}`);

    // Test devnet - get slot
    console.log("\n=== Solana Devnet ===");
    const devnetSlot = await devnetProvider.executeWithFailover(
      async (connection) => connection.getSlot()
    );
    console.log(`Current slot: ${devnetSlot}`);

    // Get a known devnet address balance (faucet address)
    const devnetBalance = await devnetProvider.executeWithFailover(
      async (connection) => {
        // Devnet faucet address
        const { PublicKey } = await import("@solana/web3.js");
        const faucetAddress = new PublicKey(
          "9B5XszUGdMaxCZ7uSQhPzdks5ZQSmWxrmzCSvtJ6Ns6g"
        );
        return connection.getBalance(faucetAddress);
      }
    );
    console.log(
      `Sample address balance: ${devnetBalance / LAMPORTS_PER_SOL} SOL`
    );

    console.log(`Using fallback: ${devnetProvider.isCurrentlyUsingFallback()}`);
    console.log(`Metrics: ${JSON.stringify(devnetProvider.getMetrics())}`);

    console.log("\n✓ All Solana provider tests passed!");
  } catch (error) {
    console.error("Error testing Solana provider:", error);
    process.exit(1);
  }
}

testSolanaProvider();
