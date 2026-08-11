/**
 * E2E Tests for Check Balance Steps
 *
 * These tests verify the check balance functionality for both EVM and Solana chains
 * using real RPC endpoints.
 *
 * RPC URL resolution priority:
 *   1. CHAIN_RPC_CONFIG JSON (for Helm/AWS Parameter Store)
 *   2. Individual env vars (CHAIN_ETH_MAINNET_PRIMARY_RPC, etc.)
 *   3. Public RPC defaults (no API keys required)
 *
 * Run with: pnpm vitest tests/e2e/check-balance.test.ts
 */

import "dotenv/config";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

// `lib/rpc/providers/index.ts` (transitively imported via provider-factory)
// pulls in `lib/rpc/safe-ethers-fetch.ts`, which guards itself with
// `import "server-only"`. Without this mock the file-load throws under vitest.
vi.mock("server-only", () => ({}));

import {
  getRpcProviderFromUrls,
  getSolanaProviderFromUrls,
  isSolanaChain,
} from "@/lib/rpc/provider-factory";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";

// Well-known addresses for testing (don't change - these have known balances)
const TEST_ADDRESSES = {
  // Vitalik's address - always has ETH
  ETH_MAINNET: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  // Sepolia faucet address
  ETH_SEPOLIA: "0xaa00000000000000000000000000000000000000",
  // Base bridge address
  BASE_MAINNET: "0x3154Cf16ccdb4C6d922629664174b904d80F2C35",
  // Solana devnet faucet
  SOLANA_DEVNET: "9B5XszUGdMaxCZ7uSQhPzdks5ZQSmWxrmzCSvtJ6Ns6g",
  // Solana mainnet - Phantom treasury
  SOLANA_MAINNET: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq",
};

// Parse JSON config and create resolver
const rpcConfig = parseRpcConfig(process.env.CHAIN_RPC_CONFIG);
const getRpcUrl = createRpcUrlResolver(rpcConfig);

// RPC URLs from JSON config, environment, or public defaults
const RPC_URLS = {
  ETH_MAINNET: {
    primary: getRpcUrl(
      "eth-mainnet",
      "CHAIN_ETH_MAINNET_PRIMARY_RPC",
      PUBLIC_RPCS.ETH_MAINNET,
      "primary"
    ),
    fallback: getRpcUrl(
      "eth-mainnet",
      "CHAIN_ETH_MAINNET_FALLBACK_RPC",
      PUBLIC_RPCS.ETH_MAINNET_FALLBACK,
      "fallback"
    ),
  },
  ETH_SEPOLIA: {
    primary: getRpcUrl(
      "sepolia",
      "CHAIN_SEPOLIA_PRIMARY_RPC",
      PUBLIC_RPCS.SEPOLIA,
      "primary"
    ),
    fallback: getRpcUrl(
      "sepolia",
      "CHAIN_SEPOLIA_FALLBACK_RPC",
      PUBLIC_RPCS.SEPOLIA,
      "fallback"
    ),
  },
  BASE_MAINNET: {
    primary: getRpcUrl(
      "base-mainnet",
      "CHAIN_BASE_MAINNET_PRIMARY_RPC",
      PUBLIC_RPCS.BASE_MAINNET,
      "primary"
    ),
    fallback: getRpcUrl(
      "base-mainnet",
      "CHAIN_BASE_MAINNET_FALLBACK_RPC",
      PUBLIC_RPCS.BASE_MAINNET,
      "fallback"
    ),
  },
  SOLANA_MAINNET: {
    primary: getRpcUrl(
      "solana-mainnet",
      "CHAIN_SOLANA_MAINNET_PRIMARY_RPC",
      PUBLIC_RPCS.SOLANA_MAINNET,
      "primary"
    ),
    fallback: getRpcUrl(
      "solana-mainnet",
      "CHAIN_SOLANA_MAINNET_FALLBACK_RPC",
      PUBLIC_RPCS.SOLANA_MAINNET,
      "fallback"
    ),
  },
  SOLANA_DEVNET: {
    primary: getRpcUrl(
      "solana-devnet",
      "CHAIN_SOLANA_DEVNET_PRIMARY_RPC",
      PUBLIC_RPCS.SOLANA_DEVNET,
      "primary"
    ),
    fallback: getRpcUrl(
      "solana-devnet",
      "CHAIN_SOLANA_DEVNET_FALLBACK_RPC",
      PUBLIC_RPCS.SOLANA_DEVNET,
      "fallback"
    ),
  },
};

describe("Check Balance E2E", () => {
  describe("EVM Chains", () => {
    it("should check balance on Ethereum Mainnet", async () => {
      const provider = await getRpcProviderFromUrls(
        RPC_URLS.ETH_MAINNET.primary,
        RPC_URLS.ETH_MAINNET.fallback,
        1,
        "Ethereum Mainnet"
      );

      const balance = await provider.executeWithFailover(
        async (p) => await p.getBalance(TEST_ADDRESSES.ETH_MAINNET)
      );

      console.log(`ETH Mainnet balance: ${balance} wei`);

      // Vitalik should have some ETH
      expect(balance).toBeGreaterThan(BigInt(0));
      expect(provider.isCurrentlyUsingFallback()).toBe(false);
    });

    it("should check balance on Sepolia Testnet", async () => {
      const provider = await getRpcProviderFromUrls(
        RPC_URLS.ETH_SEPOLIA.primary,
        RPC_URLS.ETH_SEPOLIA.fallback,
        11_155_111,
        "Sepolia Testnet"
      );

      const balance = await provider.executeWithFailover(
        async (p) => await p.getBalance(TEST_ADDRESSES.ETH_SEPOLIA)
      );

      console.log(`Sepolia balance: ${balance} wei`);

      // Balance could be 0 or more, just verify the call works
      expect(balance).toBeGreaterThanOrEqual(BigInt(0));
    });

    it("should check balance on Base Mainnet", async () => {
      const provider = await getRpcProviderFromUrls(
        RPC_URLS.BASE_MAINNET.primary,
        RPC_URLS.BASE_MAINNET.fallback,
        8453,
        "Base Mainnet"
      );

      const balance = await provider.executeWithFailover(
        async (p) => await p.getBalance(TEST_ADDRESSES.BASE_MAINNET)
      );

      console.log(`Base Mainnet balance: ${balance} wei`);

      // Bridge contract should have ETH
      expect(balance).toBeGreaterThanOrEqual(BigInt(0));
    });

    it("should handle zero address", { timeout: 30_000 }, async () => {
      const provider = await getRpcProviderFromUrls(
        RPC_URLS.ETH_MAINNET.primary,
        RPC_URLS.ETH_MAINNET.fallback,
        1,
        "Ethereum Mainnet (Zero Address)"
      );

      // Zero address actually has balance on mainnet (burnt ETH)
      const balance = await provider.executeWithFailover(
        async (p) =>
          await p.getBalance("0x0000000000000000000000000000000000000000")
      );

      console.log(`Zero address balance: ${balance} wei`);

      // Just verify the call works and returns a bigint
      expect(typeof balance).toBe("bigint");
    });
  });

  describe("Solana Chains", () => {
    it("should check balance on Solana Mainnet", async () => {
      const provider = await getSolanaProviderFromUrls(
        RPC_URLS.SOLANA_MAINNET.primary,
        RPC_URLS.SOLANA_MAINNET.fallback,
        "Solana Mainnet"
      );

      const { PublicKey } = await import("@solana/web3.js");
      const pubkey = new PublicKey(TEST_ADDRESSES.SOLANA_MAINNET);

      const balance = await provider.executeWithFailover(
        async (connection) => await connection.getBalance(pubkey)
      );

      console.log(`Solana Mainnet balance: ${balance / LAMPORTS_PER_SOL} SOL`);

      // Should have some balance
      expect(balance).toBeGreaterThanOrEqual(0);
      expect(provider.isCurrentlyUsingFallback()).toBe(false);
    });

    it("should check balance on Solana Devnet", async () => {
      const provider = await getSolanaProviderFromUrls(
        RPC_URLS.SOLANA_DEVNET.primary,
        RPC_URLS.SOLANA_DEVNET.fallback,
        "Solana Devnet"
      );

      const { PublicKey } = await import("@solana/web3.js");
      const pubkey = new PublicKey(TEST_ADDRESSES.SOLANA_DEVNET);

      const balance = await provider.executeWithFailover(
        async (connection) => await connection.getBalance(pubkey)
      );

      console.log(`Solana Devnet balance: ${balance / LAMPORTS_PER_SOL} SOL`);

      // Devnet faucet should have lots of SOL
      expect(balance).toBeGreaterThan(0);
    });

    it("should get slot number", async () => {
      const provider = await getSolanaProviderFromUrls(
        RPC_URLS.SOLANA_MAINNET.primary,
        RPC_URLS.SOLANA_MAINNET.fallback,
        "Solana Mainnet"
      );

      const slot = await provider.executeWithFailover(
        async (connection) => await connection.getSlot()
      );

      console.log(`Solana Mainnet slot: ${slot}`);

      expect(slot).toBeGreaterThan(0);
    });

    it("should get account info", async () => {
      const provider = await getSolanaProviderFromUrls(
        RPC_URLS.SOLANA_MAINNET.primary,
        RPC_URLS.SOLANA_MAINNET.fallback,
        "Solana Mainnet"
      );

      const { PublicKey } = await import("@solana/web3.js");
      const pubkey = new PublicKey(TEST_ADDRESSES.SOLANA_MAINNET);

      const accountInfo = await provider.executeWithFailover(
        async (connection) => await connection.getAccountInfo(pubkey)
      );

      console.log(`Solana account exists: ${accountInfo !== null}`);

      // Account should exist
      expect(accountInfo).not.toBeNull();
    });
  });

  describe("Chain Type Detection", () => {
    it("should correctly identify Solana chains", () => {
      expect(isSolanaChain(101)).toBe(true); // Solana Mainnet
      expect(isSolanaChain(103)).toBe(true); // Solana Devnet
      expect(isSolanaChain(1)).toBe(false); // Ethereum Mainnet
      expect(isSolanaChain(8453)).toBe(false); // Base
      expect(isSolanaChain(42_431)).toBe(false); // Tempo Testnet
    });
  });

  describe("Failover Behavior", () => {
    it("should failover to fallback on EVM when primary fails", async () => {
      // Use an invalid primary URL to force failover
      const provider = await getRpcProviderFromUrls(
        "https://invalid-rpc-url-that-does-not-exist.example.com",
        RPC_URLS.ETH_MAINNET.fallback,
        1,
        "Ethereum Mainnet (Failover Test)"
      );

      const balance = await provider.executeWithFailover(
        async (p) => await p.getBalance(TEST_ADDRESSES.ETH_MAINNET)
      );

      console.log(`Balance after failover: ${balance} wei`);

      expect(balance).toBeGreaterThan(BigInt(0));
      expect(provider.isCurrentlyUsingFallback()).toBe(true);
    });

    it("should failover to fallback on Solana when primary fails", async () => {
      // Use an invalid primary URL to force failover
      const provider = await getSolanaProviderFromUrls(
        "https://invalid-rpc-url-that-does-not-exist.example.com",
        RPC_URLS.SOLANA_DEVNET.fallback,
        "Solana Devnet (Failover Test)"
      );

      const slot = await provider.executeWithFailover(
        async (connection) => await connection.getSlot()
      );

      console.log(`Slot after failover: ${slot}`);

      expect(slot).toBeGreaterThan(0);
      expect(provider.isCurrentlyUsingFallback()).toBe(true);
    });
  });

  describe("Metrics Collection", () => {
    it("should track EVM request metrics", async () => {
      const provider = await getRpcProviderFromUrls(
        RPC_URLS.ETH_MAINNET.primary,
        RPC_URLS.ETH_MAINNET.fallback,
        1,
        "Ethereum Mainnet"
      );

      // Get initial metrics
      const initialMetrics = provider.getMetrics();
      const initialTotal = initialMetrics.totalRequests;

      // Make a few requests
      await provider.executeWithFailover((p) =>
        p.getBalance(TEST_ADDRESSES.ETH_MAINNET)
      );
      await provider.executeWithFailover((p) =>
        p.getBalance(TEST_ADDRESSES.ETH_MAINNET)
      );

      const metrics = provider.getMetrics();

      console.log("EVM Metrics:", metrics);

      // Verify requests increased by 2
      expect(metrics.totalRequests).toBe(initialTotal + 2);
      expect(metrics.primaryAttempts).toBeGreaterThanOrEqual(initialTotal + 2);
    });

    it("should track Solana request metrics", async () => {
      const provider = await getSolanaProviderFromUrls(
        RPC_URLS.SOLANA_DEVNET.primary,
        RPC_URLS.SOLANA_DEVNET.fallback,
        "Solana Devnet"
      );

      // Get initial metrics
      const initialMetrics = provider.getMetrics();
      const initialTotal = initialMetrics.totalRequests;

      // Make a few requests
      await provider.executeWithFailover((c) => c.getSlot());
      await provider.executeWithFailover((c) => c.getSlot());

      const metrics = provider.getMetrics();

      console.log("Solana Metrics:", metrics);

      // Verify requests increased by 2
      expect(metrics.totalRequests).toBe(initialTotal + 2);
      expect(metrics.primaryAttempts).toBeGreaterThanOrEqual(initialTotal + 2);
    });
  });
});
