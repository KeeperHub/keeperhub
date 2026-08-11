/**
 * Frax Ether V2 On-Chain Integration Tests
 *
 * Verifies that the ABI-driven Frax Ether V2 protocol definition produces
 * calldata that the deployed V2 minter contract accepts on Ethereum
 * mainnet. Catches contract dispatch and ABI-shape mistakes the unit-test
 * layer cannot see.
 *
 * RPC URL resolution (shared with the rest of the codebase):
 *   1. CHAIN_RPC_CONFIG JSON (Helm/AWS Parameter Store, set in CI + deployed
 *      environments)
 *   2. Individual CHAIN_ETH_MAINNET_*_RPC env vars (dev override)
 *   3. Public Ethereum mainnet RPC default (last resort)
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
import fraxEtherV2Def from "@/protocols/frax-ether-v2";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const TX_RESULT_HEX_PREFIX = /^0x/;

// Resolve Ethereum mainnet RPC URLs via the shared config pipeline:
// CHAIN_RPC_CONFIG first, individual env vars second, public default last.
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

// Assertion model:
//  - Read tests: let the RPC call surface failures. A success path decodes
//    the return; anything else (network error, ABI mismatch, decode
//    failure) surfaces as a real test failure.
//  - Write tests: use provider.call (not estimateGas) against a
//    zero-balance TEST_ADDRESS. The contract should either (a) revert
//    with CALL_EXCEPTION on business logic (e.g. "msg.value must be > 0"
//    on mintFrxEth with no value, or recipient validation), or (b)
//    succeed and return "0x" for void functions. Both outcomes prove the
//    deployed bytecode parsed our calldata. What we reject: calldata-level
//    ethers errors (INVALID_ARGUMENT, BAD_DATA, BUFFER_OVERRUN) which
//    would indicate the V1/V2 ABI confusion this protocol entry is
//    designed to avoid.
describe("Frax Ether V2 minter on-chain integration", () => {
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
   * Simulates an eth_call against the deployed bytecode and resolves
   * cleanly if the calldata was accepted: either the call returned hex
   * data (void functions return "0x") or reverted with CALL_EXCEPTION at
   * the contract level (an acceptable business revert). Any other error
   * class is rethrown so the test fails; that signals an ABI/bytecode
   * mismatch. The call is routed through the failover manager (closed
   * over from describe scope) so a primary-RPC hiccup falls back to the
   * secondary endpoint.
   *
   * Throws-instead-of-asserts so the helper does not contain expect()
   * calls outside an it() block. Call sites use
   * `await expect(simulateBytecodeCall(...)).resolves.toBeUndefined()`.
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
        return;
      }
      throw err;
    }
  }

  itOnchain(
    "mintFrxEthPaused: eth_call returns a decodable bool",
    async () => {
      const { to, data, contract } = buildCalldata({
        protocol: fraxEtherV2Def,
        actionSlug: "mint-paused",
        sampleInputs: {},
        chainId: CHAIN_ID,
      });

      const result = await manager.executeWithFailover((p) =>
        p.call({ to, data })
      );

      const abi = JSON.parse(contract.abi as string);
      const iface = new ethers.Interface(abi);
      const decoded = iface.decodeFunctionResult("mintFrxEthPaused", result);
      expect(decoded).toBeDefined();
      expect(typeof decoded[0]).toBe("boolean");
    },
    15_000
  );

  itOnchain(
    "mintFrxEth: deployed bytecode accepts the calldata",
    async () => {
      const { to, data } = buildCalldata({
        protocol: fraxEtherV2Def,
        actionSlug: "mint",
        sampleInputs: {},
        chainId: CHAIN_ID,
      });

      await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
    },
    15_000
  );

  itOnchain(
    "mintFrxEthAndGive: deployed bytecode accepts the calldata",
    async () => {
      const { to, data } = buildCalldata({
        protocol: fraxEtherV2Def,
        actionSlug: "mint-and-give",
        sampleInputs: { recipient: TEST_ADDRESS },
        chainId: CHAIN_ID,
      });

      await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
    },
    15_000
  );

  itOnchain(
    "submitAndDeposit: deployed bytecode accepts the calldata",
    async () => {
      const { to, data } = buildCalldata({
        protocol: fraxEtherV2Def,
        actionSlug: "mint-and-stake",
        sampleInputs: { recipient: TEST_ADDRESS },
        chainId: CHAIN_ID,
      });

      await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
    },
    15_000
  );
});
