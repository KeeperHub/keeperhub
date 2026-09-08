/**
 * Wrapped On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Wrapped protocol definition produces valid
 * calldata that real Sepolia contracts accept.
 *
 * RPC URL resolution (shared with the rest of the codebase):
 *   1. CHAIN_RPC_CONFIG JSON (Helm/AWS Parameter Store, set in CI + deployed
 *      environments)
 *   2. Individual CHAIN_SEPOLIA_*_RPC env vars (dev override)
 *   3. Public Sepolia RPC default (last resort)
 *
 * Ungated. Always runs. Public RPC backs every tier so the test is never
 * blocked by missing env vars. CI uses the paid staging endpoints via
 * CHAIN_RPC_CONFIG.
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
import wrappedDef from "@/protocols/wrapped";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "11155111";
const SEPOLIA_CHAIN_ID = 11_155_111;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";

// Resolve Sepolia RPC URLs via the shared config pipeline: CHAIN_RPC_CONFIG
// first, individual env vars second, public default last. Same machinery as
// the uniswap test and deployed services.
const rpcConfig = parseRpcConfig(process.env.CHAIN_RPC_CONFIG);
const resolveRpcUrl = createRpcUrlResolver(rpcConfig);
const SEPOLIA_PRIMARY_URL = resolveRpcUrl(
  "eth-sepolia",
  "CHAIN_SEPOLIA_PRIMARY_RPC",
  PUBLIC_RPCS.SEPOLIA,
  "primary"
);
const SEPOLIA_FALLBACK_URL = resolveRpcUrl(
  "eth-sepolia",
  "CHAIN_SEPOLIA_FALLBACK_RPC",
  PUBLIC_RPCS.SEPOLIA,
  "fallback"
);

describe("Wrapped on-chain integration", () => {
  // Route every RPC call through the failover manager so a primary-endpoint
  // hiccup falls back to the secondary instead of failing the test.
  let manager: RpcProviderManager;

  beforeAll(async () => {
    manager = await getRpcProviderFromUrls(
      SEPOLIA_PRIMARY_URL,
      SEPOLIA_FALLBACK_URL,
      SEPOLIA_CHAIN_ID,
      "sepolia"
    );
  });

  itOnchain(
    "balanceOf: eth_call returns a decodable uint256",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: wrappedDef,
        actionSlug: "balance-of",
        sampleInputs: { account: TEST_ADDRESS },
        chainId: CHAIN_ID,
      });

      const result = await manager.executeWithFailover((p) =>
        p.call({ to, data })
      );

      const abi = JSON.parse(contract.abi as string);
      const iface = new ethers.Interface(abi);
      const decoded = iface.decodeFunctionResult("balanceOf", result);
      expect(decoded).toBeDefined();
      expect(typeof decoded[0]).toBe("bigint");
    },
    15_000
  );

  itOnchain(
    "deposit: estimateGas succeeds with ETH value",
    async () => {
      const { to, data } = buildCalldata({
        protocol: wrappedDef,
        actionSlug: "wrap",
        sampleInputs: {},
        chainId: CHAIN_ID,
      });

      const gas = await manager.executeWithFailover((p) =>
        p.estimateGas({
          to,
          data,
          value: ethers.parseEther("0.001"),
          from: TEST_ADDRESS,
        })
      );

      expect(gas).toBeGreaterThan(BigInt(0));
    },
    15_000
  );

  itOnchain(
    "withdraw: calldata encodes correctly (business revert expected)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: wrappedDef,
        actionSlug: "unwrap",
        sampleInputs: { wad: "1000000000000000000" },
        chainId: CHAIN_ID,
      });

      try {
        await manager.executeWithFailover((p) =>
          p.estimateGas({
            to,
            data,
            from: TEST_ADDRESS,
          })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    15_000
  );
});
