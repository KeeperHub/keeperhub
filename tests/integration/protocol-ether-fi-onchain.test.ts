/**
 * ether.fi On-Chain Integration Tests
 *
 * Verifies that the ABI-driven ether.fi protocol definition produces calldata
 * the deployed Liquidity Pool, eETH and weETH contracts accept on Ethereum
 * mainnet, and that each read decodes to the declared type. Catches contract
 * dispatch and ABI-shape mistakes the unit-test layer cannot see.
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
 * Assertion model. Reads decode a real return value. The three writes are
 * simulated with provider.call from a zero-balance address: the contract may
 * either revert at the business layer (deposit with no value reverts
 * InvalidAmount, wrap and unwrap revert without a balance or approval) or
 * return data, and both prove the deployed bytecode parsed our calldata. What
 * is rejected is a calldata-level ethers error (INVALID_ARGUMENT, BAD_DATA,
 * BUFFER_OVERRUN), which is the ABI mismatch this file exists to catch.
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
import etherFiDef from "@/protocols/ether-fi";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const TX_RESULT_HEX_PREFIX = /^0x/;
const ONE_ETH_WEI = "1000000000000000000";
const ONE_ETH = BigInt(ONE_ETH_WEI);

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

describe("ether.fi on-chain integration", () => {
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

  /** Encodes through the registry, calls deployed bytecode, decodes with the
   *  same ABI the registry holds. */
  async function readAction(
    actionSlug: string,
    functionName: string,
    sampleInputs: Record<string, string> = {}
  ): Promise<ethers.Result> {
    const { to, data, contract } = buildCalldata({
      protocol: etherFiDef,
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

  /**
   * Resolves cleanly when the deployed bytecode accepted the calldata: either
   * the call returned hex, or it reverted with CALL_EXCEPTION at the contract
   * level (an acceptable business revert from a zero-balance sender). Any
   * other error class is rethrown so the test fails, signalling an ABI or
   * bytecode mismatch.
   *
   * Throws instead of asserting so the helper holds no expect() outside an
   * it() block. Call sites use
   * `await expect(simulateBytecodeCall(...)).resolves.toBeUndefined()`.
   */
  async function simulateBytecodeCall(
    actionSlug: string,
    sampleInputs: Record<string, string> = {}
  ): Promise<void> {
    const { to, data } = buildCalldata({
      protocol: etherFiDef,
      actionSlug,
      sampleInputs,
      chainId: CHAIN_ID,
    });
    try {
      const result = await manager.executeWithFailover((p) =>
        p.call({ to, data, from: TEST_ADDRESS })
      );
      if (!TX_RESULT_HEX_PREFIX.test(result)) {
        throw new Error(
          `Expected hex-prefixed return from eth_call, got: ${result}`
        );
      }
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "CALL_EXCEPTION"
      ) {
        return;
      }
      throw err;
    }
  }

  itOnchain(
    "getTotalPooledEther: decodes to a non-zero uint256",
    async () => {
      const decoded = await readAction(
        "get-total-pooled-ether",
        "getTotalPooledEther"
      );
      expect(typeof decoded[0]).toBe("bigint");
      // Pool TVL was about 2.2M ETH on 2026-09-10. Zero means a misdecode.
      expect(decoded[0] > BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "getRate: decodes at or above 1e18",
    async () => {
      const decoded = await readAction("get-rate", "getRate");
      expect(typeof decoded[0]).toBe("bigint");
      // Monotonic from 1e18 as rewards accrue, so below it means a misdecode
      // rather than a rate that fell.
      expect(decoded[0] >= ONE_ETH).toBe(true);
    },
    15_000
  );

  itOnchain(
    "amountForShare and getEETHByWeETH agree on the share price",
    async () => {
      // The pool's share price and the wrapper's rate are the same number.
      // Reading both and comparing catches a wrong contract address that a
      // single non-zero read would pass.
      const [poolSide, wrapperSide, rate] = await Promise.all([
        readAction("amount-for-share", "amountForShare", {
          shares: ONE_ETH_WEI,
        }),
        readAction("get-eeth-by-weeth", "getEETHByWeETH", {
          amount: ONE_ETH_WEI,
        }),
        readAction("get-rate", "getRate"),
      ]);
      expect(poolSide[0]).toBe(wrapperSide[0]);
      expect(poolSide[0]).toBe(rate[0]);
    },
    20_000
  );

  itOnchain(
    "sharesForAmount: decodes to a non-zero uint256",
    async () => {
      const decoded = await readAction("shares-for-amount", "sharesForAmount", {
        ethAmount: ONE_ETH_WEI,
      });
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0] > BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "getWeETHByeETH: decodes to a non-zero uint256",
    async () => {
      const decoded = await readAction("get-weeth-by-eeth", "getWeETHByeETH", {
        amount: ONE_ETH_WEI,
      });
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0] > BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "eETH totalShares: decodes to a non-zero uint256",
    async () => {
      const decoded = await readAction("eeth-total-shares", "totalShares");
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0] > BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "weETH totalSupply: decodes to a non-zero uint256",
    async () => {
      const decoded = await readAction("weeth-total-supply", "totalSupply");
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0] > BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "eETH balanceOf: decodes to a uint256",
    async () => {
      const decoded = await readAction("eeth-balance-of", "balanceOf", {
        account: TEST_ADDRESS,
      });
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0] >= BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "weETH balanceOf: decodes to a uint256",
    async () => {
      const decoded = await readAction("weeth-balance-of", "balanceOf", {
        account: TEST_ADDRESS,
      });
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0] >= BigInt(0)).toBe(true);
    },
    15_000
  );

  itOnchain(
    "deposit: deployed bytecode accepts the calldata",
    async () => {
      await expect(simulateBytecodeCall("stake")).resolves.toBeUndefined();
    },
    15_000
  );

  itOnchain(
    "wrap: deployed bytecode accepts the calldata",
    async () => {
      await expect(
        simulateBytecodeCall("wrap", { amount: ONE_ETH_WEI })
      ).resolves.toBeUndefined();
    },
    15_000
  );

  itOnchain(
    "unwrap: deployed bytecode accepts the calldata",
    async () => {
      await expect(
        simulateBytecodeCall("unwrap", { amount: ONE_ETH_WEI })
      ).resolves.toBeUndefined();
    },
    15_000
  );
});
