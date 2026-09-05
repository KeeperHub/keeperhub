/**
 * LayerZero On-Chain Integration Tests
 *
 * Proves that the ABI-driven LayerZero protocol definition produces
 * calldata the deployed contracts accept on Ethereum mainnet, and - for
 * the eleven reads - that what comes back decodes into the shapes the
 * runtime expects. The twelfth action is a write and is simulated only:
 * USDT's approve returns no data, so there is nothing to decode and that
 * test asserts acceptance rather than a return value. Three
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
// Bigint zero, spelled out because the tsconfig target predates bigint literals.
const ZERO = BigInt(0);
// The ULN config the endpoint returns as opaque bytes. Decoding it is the
// only way to assert anything that could actually fail: the endpoint always
// returns a populated struct, so a length check on the raw bytes passes
// whatever the lane's security settings are.
const ULN_CONFIG_TUPLE =
  "tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)";
// The Arbitrum OFT this adapter should be peered with, taken from the
// protocol definition's own address map rather than retyped here: if USDT0
// re-wires its peer, the definition has gone stale and this test is the
// only thing that notices.
const ARBITRUM_OFT_PEER = ethers.zeroPadValue(
  layerzeroDef.contracts.oft.addresses["42161"],
  32
);

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
//  - Write test (oft-approve): use provider.call (not estimateGas) from
//    TEST_ADDRESS, which has no allowance set for this spender. USDT
//    should either succeed and return hex, or revert with CALL_EXCEPTION
//    on business logic. Both outcomes prove the deployed bytecode parsed
//    our calldata. What we reject: calldata-level ethers errors
//    (INVALID_ARGUMENT, BAD_DATA, BUFFER_OVERRUN), which would mean the
//    definition encodes something the token does not implement.
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
      // Reaching this line at all is the coverage for payInLzToken:
      // ethers treats any non-empty string as truthy, so a "false" that
      // escaped coercion would ask to pay in ZRO, and the Ethereum
      // endpoint has no LZ token set (lzToken() is the zero address), so
      // the call would revert with LZ_LzTokenUnavailable before any
      // assertion ran.
      const fee = decoded.fee;
      expect(typeof fee.nativeFee).toBe("bigint");
      expect(fee.nativeFee).toBeGreaterThan(ZERO);
    },
    30_000
  );

  itOnchain(
    "oft-quote-oft: receipt reports the full amount received",
    async () => {
      const decoded = await callAndDecode("oft-quote-oft", SEND_PARAM_SAMPLE);

      // Three tuple outputs: oftLimit, oftFeeDetails[], oftReceipt.
      const receipt = decoded.oftReceipt;
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

      // USDT, not the adapter's own address: this is a lock-and-unlock
      // adapter over an existing token, which is why the approve action
      // targets a different contract from every other OFT action here.
      expect(ethers.getAddress(decoded[0])).toBe(ethers.getAddress(USDT));
    },
    30_000
  );

  itOnchain(
    "oft-peer: the Arbitrum lane is wired",
    async () => {
      const decoded = await callAndDecode("oft-peer", { eid: ARBITRUM_EID });

      // bytes32. All zeros would mean the lane is not wired and a send to
      // it reverts. Pinned to the Arbitrum OFT the definition itself
      // lists, so this fails in the two cases worth knowing about: the
      // lane is unwired, or USDT0 re-pointed it and the definition's
      // address map is now stale.
      expect(decoded[0]).toBe(ARBITRUM_OFT_PEER);
    },
    30_000
  );

  itOnchain(
    "oft-check-balance: adapter holds the locked USDT",
    async () => {
      const decoded = await callAndDecode("oft-check-balance", {
        account: USDT0_OFT_ADAPTER,
      });

      // Read against the adapter rather than an arbitrary address so the
      // assertion can fail: a lock-and-unlock adapter custodies the USDT
      // backing every USDT0 in circulation, so an empty balance would
      // mean the calldata reached the wrong contract.
      expect(typeof decoded[0]).toBe("bigint");
      expect(decoded[0]).toBeGreaterThan(ZERO);
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

      // Shape only, deliberately: this reference wallet has granted no
      // approval, so any specific value would be pinning an accident.
      // The coverage is that USDT accepted the two-address calldata and
      // the return decoded as a uint256.
      expect(typeof decoded[0]).toBe("bigint");
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

      // Safe to pin: USDT0 sets this library explicitly rather than
      // inheriting it (isDefaultSendLibrary(adapter, 30110) is false), so
      // a LayerZero default-library rotation cannot redden this. Only a
      // reconfiguration by the USDT0 owner would.
      expect(ethers.getAddress(decoded[0])).toBe(
        ethers.getAddress(SEND_ULN_302)
      );
    },
    30_000
  );

  itOnchain(
    "endpoint-get-config: the ULN config decodes to a usable DVN set",
    async () => {
      const decoded = await callAndDecode("endpoint-get-config", {
        oapp: USDT0_OFT_ADAPTER,
        lib: SEND_ULN_302,
        eid: ARBITRUM_EID,
        configType: CONFIG_TYPE_ULN,
      });

      // The action returns opaque bytes, so decode them the way a
      // workflow comparing against a security baseline would. Asserting
      // internal consistency rather than a fixed DVN set: these hold for
      // any correctly configured lane, so adding or swapping a DVN does
      // not redden the test, but a lane with no verifier or a truncated
      // config does. Observed 2026-09-05: 65 confirmations, 3 required
      // DVNs.
      const [uln] = ethers.AbiCoder.defaultAbiCoder().decode(
        [ULN_CONFIG_TUPLE],
        decoded[0] as string
      );
      expect(uln.confirmations).toBeGreaterThan(ZERO);
      expect(uln.requiredDVNCount).toBeGreaterThan(ZERO);
      expect(uln.requiredDVNs.length).toBe(Number(uln.requiredDVNCount));
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

      // No decode here, unlike the eleven reads: USDT's approve returns
      // no data at all, so a successful call comes back as "0x" and
      // there is nothing to assert a shape against. Acceptance by the
      // deployed bytecode is the whole of the coverage.
      await expect(simulateBytecodeCall({ to, data })).resolves.toBeUndefined();
    },
    30_000
  );
});
