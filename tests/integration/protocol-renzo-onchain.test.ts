/**
 * Renzo On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Renzo protocol definition produces
 * calldata that the deployed RestakeManager and ezETH contracts accept
 * on Ethereum mainnet. Catches contract dispatch and ABI-shape mistakes
 * the unit-test layer cannot see.
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
 */

import { ethers } from "ethers";
import { beforeAll, describe, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";
import renzoDef from "@/protocols/renzo";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const TX_RESULT_HEX_PREFIX = /^0x/;

/** A four-byte selector the RestakeManager does not implement. */
const UNKNOWN_SELECTOR = "0xdeadbeef";

/** Empty returndata as a hex string. Some endpoints report it this way
 *  instead of as null. See `simulateBytecodeCall`. */
const EMPTY_REVERT_DATA = "0x";

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

describe("Renzo on-chain integration", () => {
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
   * Resolves when the deployed bytecode dispatched the calldata: the call
   * returned hex or it reverted with CALL_EXCEPTION carrying revert data.
   *
   * The revert data is what makes this mean anything. A selector the contract
   * has never heard of also fails with CALL_EXCEPTION, because it falls
   * through and reverts with no returndata, so accepting any CALL_EXCEPTION
   * would pass for a function that does not exist:
   *
   *   RestakeManager 0xdeadbeef    -> CALL_EXCEPTION, empty revert data
   *   RestakeManager depositETH()  -> CALL_EXCEPTION, data 0x21607339
   *
   * Endpoints disagree on how they report empty returndata, so checking one
   * shape is not enough. Read on 2026-09-18 at mainnet block 26000715:
   * ethereum-rpc.publicnode.com answers the unknown selector with data null,
   * 1rpc.io/eth answers it with data "0x". Those are this file's own primary
   * and fallback defaults, so a null-only check discriminates on one endpoint
   * and passes an unknown selector on the other. Rejecting both shapes is what
   * makes the assertion mean what the test name says. The
   * "unknown selector is rejected" case below holds that on whichever endpoint
   * actually answers.
   */
  async function simulateBytecodeCall(tx: {
    to: string;
    data: string;
  }): Promise<void> {
    try {
      const result = await manager.executeWithFailover((p) =>
        p.call({ ...tx, from: TEST_ADDRESS })
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
        const revertData = (err as { data?: unknown }).data;
        if (revertData == null || revertData === EMPTY_REVERT_DATA) {
          throw new Error(
            `Selector ${tx.data.slice(0, 10)} on ${tx.to} reverted with no return data, which is what an unknown selector does. The deployed bytecode did not dispatch this call.`
          );
        }
        return;
      }
      throw err;
    }
  }

  itOnchain(
    "paused: eth_call returns a decodable bool",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: renzoDef,
        actionSlug: "paused",
        sampleInputs: {},
        chainId: CHAIN_ID,
      });

      const result = await manager.executeWithFailover((p) =>
        p.call({ to, data })
      );

      const abi = JSON.parse(contract.abi as string);
      const iface = new ethers.Interface(abi);
      const decoded = iface.decodeFunctionResult("paused", result);
      expect(decoded).toBeDefined();
      expect(typeof decoded[0]).toBe("boolean");
    },
    15_000
  );

  itOnchain(
    "depositETH: deployed bytecode accepts the calldata",
    async () => {
      const { to, data } = buildCalldata({
        protocol: renzoDef,
        actionSlug: "stake",
        sampleInputs: {},
        chainId: CHAIN_ID,
      });

      await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
    },
    15_000
  );

  // Holds the discriminator the case above rests on. Without it, a helper that
  // accepted the endpoint's empty-returndata shape would pass depositETH for a
  // selector the contract has never heard of, which is the whole failure mode
  // the revert-data requirement exists to rule out.
  //
  // Resolving is the only outcome that means the dispatch check has gone
  // vacuous, so that is what this pins. Any rejection is a pass, including an
  // endpoint that reports an undispatched call in some shape this file does not
  // know about: the helper rethrows that rather than accepting it, which is the
  // property under test. Runs against the same contract and the same endpoint
  // as the real case, so the two cannot disagree about which endpoint answered.
  itOnchain(
    "an unknown selector is rejected, so the dispatch check discriminates",
    async () => {
      const { to } = buildCalldata({
        protocol: renzoDef,
        actionSlug: "stake",
        sampleInputs: {},
        chainId: CHAIN_ID,
      });

      await expect(
        simulateBytecodeCall({ to, data: UNKNOWN_SELECTOR })
      ).rejects.toThrow();
    },
    15_000
  );

  itOnchain(
    "ezETH balanceOf: eth_call returns a decodable uint256",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: renzoDef,
        actionSlug: "ez-balance-of",
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
    "ezETH totalSupply: returns a non-zero uint256",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: renzoDef,
        actionSlug: "ez-total-supply",
        sampleInputs: {},
        chainId: CHAIN_ID,
      });

      const result = await manager.executeWithFailover((p) =>
        p.call({ to, data })
      );

      const abi = JSON.parse(contract.abi as string);
      const iface = new ethers.Interface(abi);
      const decoded = iface.decodeFunctionResult("totalSupply", result);
      expect(decoded).toBeDefined();
      expect(decoded[0]).toBeGreaterThan(BigInt(0));
    },
    15_000
  );
});
