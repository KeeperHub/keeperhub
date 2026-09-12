/**
 * Coinbase cbETH On-Chain Integration Tests
 *
 * Verifies that the ABI-driven cbETH protocol definition produces calldata
 * the deployed token accepts on Ethereum mainnet, and that each read decodes
 * to the type the registry declares. Catches contract dispatch and ABI-shape
 * mistakes the unit-test layer cannot see.
 *
 * RPC URL resolution (shared with the rest of the codebase):
 *   1. CHAIN_RPC_CONFIG JSON (Helm/AWS Parameter Store, set in CI +
 *      deployed environments)
 *   2. Individual CHAIN_ETH_MAINNET_*_RPC env vars (dev override)
 *   3. Public Ethereum mainnet RPC default (last resort)
 *
 * Ungated. Always runs. Public RPC backs every tier so the test is never
 * blocked by missing env vars. CI uses the paid staging endpoints via
 * CHAIN_RPC_CONFIG.
 *
 * Every action here is a view function, so each test decodes a real return
 * value rather than settling for an accepted-calldata revert.
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";
import cbethDef from "@/protocols/coinbase-cbeth";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
// Vitalik's address, chosen only because it is a well-known mainnet account
// that certainly exists; the balance read asserts type, never an amount.
const TEST_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// cbETH's exchange rate is monotonically non-decreasing from 1e18 at launch,
// so anything at or above 1 ETH per cbETH is the invariant. Read
// 1139167190088840180 on 2026-09-10.
const ONE_ETH_WEI = BigInt("1000000000000000000");

const rpcConfig = parseRpcConfig(process.env.CHAIN_RPC_CONFIG);
const resolveRpcUrl = createRpcUrlResolver(rpcConfig);
const MAINNET_PRIMARY_URL = resolveRpcUrl(
  "eth-mainnet",
  "CHAIN_ETH_MAINNET_PRIMARY_RPC",
  PUBLIC_RPCS.ETH_MAINNET,
  "primary"
);
const MAINNET_FALLBACK_URL = resolveRpcUrl(
  "eth-mainnet",
  "CHAIN_ETH_MAINNET_FALLBACK_RPC",
  PUBLIC_RPCS.ETH_MAINNET_FALLBACK,
  "fallback"
);

describe("Coinbase cbETH on-chain integration", () => {
  // Route every RPC call through the failover manager so a primary-endpoint
  // hiccup falls back to the secondary instead of failing the test.
  let manager: RpcProviderManager;

  beforeAll(async () => {
    manager = await getRpcProviderFromUrls(
      MAINNET_PRIMARY_URL,
      MAINNET_FALLBACK_URL,
      MAINNET_CHAIN_ID,
      "ethereum"
    );
  });

  /**
   * Encodes an action through the registry, calls it against deployed
   * bytecode, and decodes the result with the same ABI the registry holds.
   * A dispatch or ABI-shape mistake surfaces here as a decode failure.
   */
  async function readAction(
    actionSlug: string,
    functionName: string,
    sampleInputs: Record<string, string> = {}
  ): Promise<ethers.Result> {
    const { to, data, contract } = buildCalldata({
      protocol: cbethDef,
      actionSlug,
      sampleInputs,
      chainId: CHAIN_ID,
    });
    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const iface = new ethers.Interface(JSON.parse(contract.abi as string));
    return iface.decodeFunctionResult(functionName, result);
  }

  itOnchain(
    "exchangeRate: decodes to a uint256 at or above 1e18",
    async () => {
      const decoded = await readAction("exchange-rate", "exchangeRate");
      expect(typeof decoded[0]).toBe("bigint");
      // Monotonic from 1e18, so a value below it means a wrong contract or a
      // misdecoded return rather than a rate that fell.
      expect(decoded[0] >= ONE_ETH_WEI).toBe(true);
    },
    15_000
  );

  itOnchain(
    "balanceOf: decodes to a uint256 for a real account",
    async () => {
      const decoded = await readAction("balance-of", "balanceOf", {
        account: TEST_ADDRESS,
      });
      expect(typeof decoded[0]).toBe("bigint");
      // No amount assertion: any address's balance is history-dependent and
      // may legitimately be zero.
      expect(decoded[0] >= BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "totalSupply: decodes to a non-zero uint256",
    async () => {
      const decoded = await readAction("total-supply", "totalSupply");
      expect(typeof decoded[0]).toBe("bigint");
      // Supply was about 393,750 cbETH on 2026-09-10. Zero here means the
      // read decoded garbage rather than the supply actually emptying.
      expect(decoded[0] > BigInt(0)).toBe(true);
    },
    15_000
  );
});
