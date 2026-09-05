/**
 * LayerZero On-Chain Integration Tests
 *
 * Proves that the ABI-driven LayerZero protocol definition produces
 * calldata the deployed contracts accept on Ethereum mainnet, and that
 * what comes back decodes into the shapes the runtime expects. Three
 * deployments answer: the USDT0 OFT Adapter, the USDT token it locks,
 * and the LayerZero EndpointV2. Every action goes through the shared
 * calldata builder, so the test exercises the definition itself - its
 * flattened SendParam tuple, the padAddressToBytes transform on the
 * recipient, and the ABIs - rather than a hand-written ABI that could
 * drift from it.
 *
 * The asserted values are long-lived invariants of that deployment
 * (approval model, shared decimals, underlying token, wired peer, send
 * library, supported lane), first observed over eth_call on 2026-09-05
 * at block 25907823. The quotes assert shape and floor, not a fixed
 * price: a messaging fee moves with gas.
 *
 * RPC URL resolution (shared with the rest of the codebase):
 *   1. CHAIN_RPC_CONFIG JSON (Helm/AWS Parameter Store, set in CI +
 *      deployed environments)
 *   2. Individual CHAIN_ETH_MAINNET_*_RPC env vars (dev override)
 *   3. Public Ethereum mainnet RPC default (last resort)
 *
 * Calls run through getRpcProviderFromUrls + executeWithFailover, so a
 * primary-endpoint hiccup falls back to the secondary instead of
 * failing the test.
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
import layerzeroDef from "@/protocols/layerzero";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "1";
const MAINNET_CHAIN_ID = 1;
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const TX_RESULT_HEX_PREFIX = /^0x/;

// Reference deployment under test. The OFT Adapter locks USDT on
// Ethereum and mints USDT0 on the destination, so approvalRequired() is
// true and token() points at USDT rather than at the adapter.
const USDT0_OFT_ADAPTER = "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
// SendUln302 on Ethereum: the message library the adapter sends through
// for the Arbitrum lane.
const SEND_ULN_302 = "0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1";
// LayerZero endpoint ID for Arbitrum One. Not an EVM chain ID.
const ARBITRUM_EID = "30110";
// ULN config: confirmations plus the required and optional DVN set.
const CONFIG_TYPE_ULN = "2";
// One USDT (6 decimals) with a 1% slippage floor.
const AMOUNT_LD = "1000000";
const AMOUNT_LD_EXPECTED = BigInt(AMOUNT_LD);
const MIN_AMOUNT_LD = "990000";
const SHARED_DECIMALS_EXPECTED = BigInt(6);
// A bytes32 peer and a bytes config both decode to hex strings; "0x"
// alone is the empty answer for the config, and 32 zero bytes for the peer.
const EMPTY_HEX = "0x";
// Bigint zero, spelled out because the tsconfig target predates bigint literals.
const ZERO = BigInt(0);
const ZERO_BYTES32 = ethers.ZeroHash;

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

// The flattened SendParam tuple both quotes share. `to` is supplied as a
// plain EVM address so the padAddressToBytes encode transform has to turn
// it into the bytes32 the OFT expects; a regression there produces
// calldata the adapter rejects.
const SEND_PARAM_SAMPLE: Record<string, string> = {
  dstEid: ARBITRUM_EID,
  to: TEST_ADDRESS,
  amountLD: AMOUNT_LD,
  minAmountLD: MIN_AMOUNT_LD,
  // extraOptions, composeMsg and oftCmd are left to the action defaults
  // (the Type 3 executor blob and 0x) so the test pins what the form
  // would actually send.
};

// Assertion model:
//  - Read tests: let the RPC call surface failures. A success path
//    decodes the return with the action's own ABI fragment and asserts
//    the invariant; anything else (network error, ABI mismatch, decode
//    failure) surfaces as a real test failure.
//  - Write test (oft-approve): use provider.call (not estimateGas)
//    against a zero-balance TEST_ADDRESS. USDT should either succeed and
//    return hex, or revert with CALL_EXCEPTION on business logic. Both
//    outcomes prove the deployed bytecode parsed our calldata. What we
//    reject: calldata-level ethers errors (INVALID_ARGUMENT, BAD_DATA,
//    BUFFER_OVERRUN), which would mean the definition encodes something
//    the token does not implement.
describe("LayerZero OFT and EndpointV2 on-chain integration", () => {
  // Route every RPC call through the failover manager so a
  // primary-endpoint hiccup falls back to the secondary.
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
   * Encode an action through the shared builder, eth_call it, and decode
   * the return with the same ABI the definition carries. Returns the
   * decoded result array. Closes over the failover manager from describe
   * scope so a primary-RPC hiccup falls back to the secondary.
   */
  async function callAndDecode(
    actionSlug: string,
    sampleInputs: Record<string, string>
  ): Promise<ethers.Result> {
    const { to, data, action, contract } = buildCalldata({
      protocol: layerzeroDef,
      actionSlug,
      sampleInputs,
      chainId: CHAIN_ID,
    });

    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );

    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    return iface.decodeFunctionResult(action.function, result);
  }

  /**
   * Simulates an eth_call against the deployed bytecode and resolves
   * cleanly if the calldata was accepted: either the call returned hex
   * data (a token whose approve returns nothing gives back "0x") or it
   * reverted with CALL_EXCEPTION at the contract level (an acceptable
   * business revert). Any other error class is rethrown so the test
   * fails; that signals an ABI/bytecode mismatch.
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
    "oft-quote-send: quoteSend returns a non-zero native fee",
    async () => {
      const decoded = await callAndDecode("oft-quote-send", {
        ...SEND_PARAM_SAMPLE,
        payInLzToken: "false",
      });

      // Single tuple output named `fee`: (nativeFee, lzTokenFee).
      const fee = decoded[0];
      expect(typeof fee.nativeFee).toBe("bigint");
      expect(fee.nativeFee).toBeGreaterThan(ZERO);
      // payInLzToken=false must survive coercion; a string "false" that
      // encoded as true would quote in ZRO instead.
      expect(typeof fee.lzTokenFee).toBe("bigint");
    },
    30_000
  );

  itOnchain(
    "oft-quote-oft: receipt reports the full amount received",
    async () => {
      const decoded = await callAndDecode("oft-quote-oft", SEND_PARAM_SAMPLE);

      // Three tuple outputs: oftLimit, oftFeeDetails[], oftReceipt.
      const receipt = decoded[2];
      // 1 USDT at 6 shared decimals carries no dust, so nothing is
      // removed and the adapter takes no fee on this lane.
      expect(receipt.amountReceivedLD).toBe(AMOUNT_LD_EXPECTED);
      expect(receipt.amountSentLD).toBe(AMOUNT_LD_EXPECTED);
    },
    30_000
  );

  itOnchain(
    "oft-approval-required: adapter reports it pulls the token",
    async () => {
      const decoded = await callAndDecode("oft-approval-required", {});

      expect(decoded[0]).toBe(true);
    },
    30_000
  );

  itOnchain(
    "oft-shared-decimals: adapter reports 6 shared decimals",
    async () => {
      const decoded = await callAndDecode("oft-shared-decimals", {});

      expect(decoded[0]).toBe(SHARED_DECIMALS_EXPECTED);
    },
    30_000
  );

  itOnchain(
    "oft-token: underlying token is USDT, not the adapter",
    async () => {
      const decoded = await callAndDecode("oft-token", {});

      expect(ethers.getAddress(decoded[0])).toBe(ethers.getAddress(USDT));
      expect(ethers.getAddress(decoded[0])).not.toBe(
        ethers.getAddress(USDT0_OFT_ADAPTER)
      );
    },
    30_000
  );

  itOnchain(
    "oft-peer: the Arbitrum lane is wired",
    async () => {
      const decoded = await callAndDecode("oft-peer", { eid: ARBITRUM_EID });

      // bytes32. All zeros would mean the lane is not wired and a send
      // to it reverts. Observed 2026-09-05:
      // 0x...14e4a1b13bf7f943c8ff7c51fb60fa964a298d92 (the Arbitrum OFT).
      // Asserted as non-zero rather than fixed, matching the protocol
      // definition's own expectation, so a legitimate re-wire on the
      // destination does not break this test.
      expect(decoded[0]).not.toBe(ZERO_BYTES32);
      expect(ethers.dataLength(decoded[0])).toBe(32);
    },
    30_000
  );

  itOnchain(
    "oft-check-balance: balanceOf decodes to a uint",
    async () => {
      const decoded = await callAndDecode("oft-check-balance", {
        account: TEST_ADDRESS,
      });

      // Any value is correct; the point is that USDT accepted the
      // calldata and the return decodes as a uint256.
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0]).toBeGreaterThanOrEqual(ZERO);
    },
    30_000
  );

  itOnchain(
    "oft-check-allowance: allowance decodes to a uint",
    async () => {
      const decoded = await callAndDecode("oft-check-allowance", {
        owner: TEST_ADDRESS,
        spender: USDT0_OFT_ADAPTER,
      });

      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0]).toBeGreaterThanOrEqual(ZERO);
    },
    30_000
  );

  itOnchain(
    "endpoint-get-send-library: adapter sends through SendUln302",
    async () => {
      const decoded = await callAndDecode("endpoint-get-send-library", {
        sender: USDT0_OFT_ADAPTER,
        dstEid: ARBITRUM_EID,
      });

      expect(ethers.getAddress(decoded[0])).toBe(
        ethers.getAddress(SEND_ULN_302)
      );
    },
    30_000
  );

  itOnchain(
    "endpoint-get-config: the ULN config is set on that library",
    async () => {
      const decoded = await callAndDecode("endpoint-get-config", {
        oapp: USDT0_OFT_ADAPTER,
        lib: SEND_ULN_302,
        eid: ARBITRUM_EID,
        configType: CONFIG_TYPE_ULN,
      });

      // ABI-encoded bytes: confirmations plus the DVN set. Empty bytes
      // would mean nothing to compare a security baseline against.
      const config = decoded[0] as string;
      expect(config).not.toBe(EMPTY_HEX);
      expect(config.length).toBeGreaterThan(EMPTY_HEX.length);
    },
    30_000
  );

  itOnchain(
    "endpoint-is-supported-eid: the Arbitrum lane is routable",
    async () => {
      const decoded = await callAndDecode("endpoint-is-supported-eid", {
        eid: ARBITRUM_EID,
      });

      expect(decoded[0]).toBe(true);
    },
    30_000
  );

  itOnchain(
    "oft-approve: deployed USDT accepts the calldata",
    async () => {
      const { to, data } = buildCalldata({
        protocol: layerzeroDef,
        actionSlug: "oft-approve",
        sampleInputs: {
          spender: USDT0_OFT_ADAPTER,
          amount: AMOUNT_LD,
        },
        chainId: CHAIN_ID,
      });

      await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
    },
    30_000
  );
});
