/**
 * Uniswap V3 On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Uniswap V3 protocol definition produces
 * calldata that real Sepolia Uniswap V3 contracts accept.
 *
 * RPC URL resolution (shared with the rest of the codebase):
 *   1. CHAIN_RPC_CONFIG JSON (Helm/AWS Parameter Store, set in CI + deployed
 *      environments)
 *   2. Individual CHAIN_SEPOLIA_*_RPC env vars (dev override)
 *   3. Public Sepolia RPC default (last resort)
 *
 * Uses getRpcProviderFromUrls + executeWithFailover so primary RPC failures
 * transparently fail over to the fallback URL - same failover machinery
 * deployed services use.
 *
 * Ungated. Always runs. Public RPC backs every tier so the test is never
 * blocked by missing env vars. CI uses the paid staging endpoints via
 * CHAIN_RPC_CONFIG.
 *
 * Test philosophy: verify derived calldata is valid ABI, not that business
 * operations succeed. Pools may lack liquidity on Sepolia and position
 * token IDs may not exist; the try/catch paths accept those reverts as
 * long as the error is not an ABI encoding failure.
 */

import { ethers } from "ethers";
import { describe, expect, vi } from "vitest";

// `lib/rpc/providers` transitively imports `lib/safe-fetch` (via the
// safe-ethers adapter), which declares `import "server-only"` and would
// otherwise throw under vitest's Node runtime.
vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";
import uniswapDef from "@/protocols/uniswap-v3";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "11155111"; // Sepolia
const CHAIN_ID_NUMBER = 11_155_111;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

// Sepolia token addresses used for read-path tests. The WETH/USDC 0.3% pool
// has had liquidity historically; if it lacks liquidity at test time the
// quote calls revert with a business error and the try/catch still asserts
// the calldata was well-formed.
const SEPOLIA_WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const FEE_TIER_030 = "3000";
const ONE_ETH = "1000000000000000000";

// Resolve Sepolia RPC URLs via the shared config pipeline: CHAIN_RPC_CONFIG
// first, individual env vars second, public default last.
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

describe("Uniswap V3 on-chain integration (Sepolia)", () => {
  const makeProvider = () =>
    getRpcProviderFromUrls(
      SEPOLIA_PRIMARY_URL,
      SEPOLIA_FALLBACK_URL,
      CHAIN_ID_NUMBER,
      "Sepolia (Uniswap V3 integration test)"
    );

  // -- factory ---------------------------------------------------------------

  itOnchain(
    "get-pool: eth_call returns a decodable address",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "get-pool",
        sampleInputs: {
          tokenA: SEPOLIA_WETH,
          tokenB: SEPOLIA_USDC,
          fee: FEE_TIER_030,
        },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      const result = await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );
      const iface = new ethers.Interface(JSON.parse(contract.abi as string));
      const decoded = iface.decodeFunctionResult("getPool", result);
      expect(decoded).toBeDefined();
      expect(typeof decoded[0]).toBe("string");
      expect(decoded[0]).toMatch(HEX_ADDRESS_REGEX);
    },
    30_000
  );

  // -- positionManager -------------------------------------------------------

  itOnchain(
    "balance-of: eth_call returns a decodable uint256",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "balance-of",
        sampleInputs: { owner: TEST_ADDRESS },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      const result = await provider.executeWithFailover(
        async (p) => await p.call({ to, data })
      );
      const iface = new ethers.Interface(JSON.parse(contract.abi as string));
      const decoded = iface.decodeFunctionResult("balanceOf", result);
      expect(decoded).toBeDefined();
      expect(typeof decoded[0]).toBe("bigint");
    },
    30_000
  );

  itOnchain(
    "owner-of: calldata encodes (business revert expected for invalid tokenId)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "owner-of",
        sampleInputs: { tokenId: "1" },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.call({ to, data })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  itOnchain(
    "get-position: calldata encodes (business revert expected for invalid tokenId)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "get-position",
        sampleInputs: { tokenId: "1" },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.call({ to, data })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  itOnchain(
    "approve-position: estimateGas calldata is valid (business revert expected)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "approve-position",
        sampleInputs: { to: TEST_ADDRESS, tokenId: "1" },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  itOnchain(
    "transfer-position: estimateGas calldata is valid (business revert expected)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "transfer-position",
        sampleInputs: { from: TEST_ADDRESS, to: TEST_ADDRESS, tokenId: "1" },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  itOnchain(
    "burn-position: estimateGas calldata is valid (business revert expected)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "burn-position",
        sampleInputs: { tokenId: "1" },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  // -- quoter (tuple-flattened inputs) ---------------------------------------

  itOnchain(
    "quote-exact-input: calldata encodes (business revert OK if pool lacks liquidity)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "quote-exact-input",
        sampleInputs: {
          tokenIn: SEPOLIA_WETH,
          tokenOut: SEPOLIA_USDC,
          amountIn: ONE_ETH,
          fee: FEE_TIER_030,
          sqrtPriceLimitX96: "0",
        },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.call({ to, data })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  itOnchain(
    "quote-exact-output: calldata encodes (business revert OK if pool lacks liquidity)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "quote-exact-output",
        sampleInputs: {
          tokenIn: SEPOLIA_WETH,
          tokenOut: SEPOLIA_USDC,
          amount: ONE_ETH,
          fee: FEE_TIER_030,
          sqrtPriceLimitX96: "0",
        },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.call({ to, data })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  // -- swapRouter (tuple-flattened inputs) -----------------------------------

  itOnchain(
    "swap-exact-input: estimateGas calldata is valid (business revert expected - no approval)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "swap-exact-input",
        sampleInputs: {
          tokenIn: SEPOLIA_WETH,
          tokenOut: SEPOLIA_USDC,
          fee: FEE_TIER_030,
          recipient: TEST_ADDRESS,
          amountIn: ONE_ETH,
          amountOutMinimum: "0",
          sqrtPriceLimitX96: "0",
        },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );

  itOnchain(
    "swap-exact-output: estimateGas calldata is valid (business revert expected - no approval)",
    async () => {
      const { to, data } = buildCalldata({
        protocol: uniswapDef,
        actionSlug: "swap-exact-output",
        sampleInputs: {
          tokenIn: SEPOLIA_WETH,
          tokenOut: SEPOLIA_USDC,
          fee: FEE_TIER_030,
          recipient: TEST_ADDRESS,
          amountOut: ONE_ETH,
          amountInMaximum: ONE_ETH,
          sqrtPriceLimitX96: "0",
        },
        chainId: CHAIN_ID,
      });

      const provider = await makeProvider();
      try {
        await provider.executeWithFailover(
          async (p) => await p.estimateGas({ to, data, from: TEST_ADDRESS })
        );
      } catch (error) {
        const msg = String(error);
        expect(msg).not.toContain("INVALID_ARGUMENT");
        expect(msg).not.toContain("could not decode");
        expect(msg).not.toContain("invalid function");
      }
    },
    30_000
  );
});
