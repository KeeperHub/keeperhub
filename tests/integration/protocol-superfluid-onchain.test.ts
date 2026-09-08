/**
 * Superfluid On-Chain Integration Tests
 *
 * Verifies that the Superfluid protocol definition produces valid calldata
 * the deployed CFA forwarder, GDA forwarder, and SuperToken contracts
 * accept on Sepolia. Catches contract dispatch and ABI-shape mistakes the
 * unit-test layer cannot see.
 *
 * Coverage: every action declared by the protocol gets at least one
 * dispatch test (read decodes, write encodes without ABI errors).
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

import type { ProtocolAction, ProtocolContract } from "@/lib/protocol-registry";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  createRpcUrlResolver,
  PUBLIC_RPCS,
  parseRpcConfig,
} from "@/lib/rpc/rpc-config";
import { safeEthersGetUrl } from "@/lib/rpc/safe-ethers-fetch";
import superfluidDef, {
  CFA_FORWARDER_ADDRESS,
  GDA_FORWARDER_ADDRESS,
} from "@/protocols/superfluid";
import { buildCalldata } from "./_shared/build-calldata";
import { itOnchain } from "./_shared/onchain-rpc";

const CHAIN_ID = "11155111";
const SEPOLIA_CHAIN_ID = 11_155_111;

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
// CHAIN_CONFIG's eth-sepolia entry has no `publicFallback` distinct from
// `publicDefault`, so with neither CHAIN_RPC_CONFIG nor CHAIN_SEPOLIA_*_RPC
// set (true for local dev; CI sets CHAIN_RPC_CONFIG with genuinely distinct
// paid endpoints) this resolves to the same literal as SEPOLIA_PRIMARY_URL.
// The fallback corroboration below still adds value in that case (a fresh
// request against the same node can succeed where a rate-limited one
// failed), but it is a same-node retry, not independent corroboration.
const SEPOLIA_FALLBACK_URL = resolveRpcUrl(
  "eth-sepolia",
  "CHAIN_SEPOLIA_FALLBACK_RPC",
  PUBLIC_RPCS.SEPOLIA,
  "fallback"
);
const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
// Distinct from TEST_ADDRESS: estimateGas runs with `from: TEST_ADDRESS`,
// and Superfluid's CFA rejects sender == flowOperator (self-grant).
const TEST_OPERATOR = "0x0000000000000000000000000000000000000002";

// fUSDCx on Sepolia. The forwarders validate the token argument against the
// Superfluid host registry and revert for unknown addresses, so reads need
// a real SuperToken. fUSDCx is the canonical Sepolia test token; an account
// with no flows returns 0, which is exactly what we want for assertions.
const SEPOLIA_FUSDCX = "0xb598E6C621618a9f63788816ffb50Ee2862D443B";
// Underlying fUSDC for fUSDCx; getUnderlyingToken should return this
// (proves we're decoding the right slot, not just any address).
const SEPOLIA_FUSDC = "0xe72f289584eDA2bE69Cfe487f4638F09bAc920Db";

// Common dummy values for write-action inputs. estimateGas will revert
// with business reverts for most of these (insufficient balance, no flow
// to update, etc.) -- that is fine; we only assert the failure mode is
// not an ABI/encoding error.
const DUMMY_AMOUNT_WEI = "1000000000000000000"; // 1e18
const DUMMY_FLOW_RATE = "1000000"; // wei/sec, small but non-zero
const DUMMY_UNITS = "1";
const DUMMY_PERMISSIONS_ALL = "7"; // create+update+delete bitmap
const DUMMY_BYTES = "0x";

// Markers we treat as failures: ABI/calldata mistakes plus the
// "contract reverted with no data" pattern. The latter is the KEEP-456
// failure mode -- routing into a non-existent SuperToken proxy returned a
// CALL_EXCEPTION with empty revert data, and the previous loose guard
// silently tolerated it. Anything else (require(false), insufficient
// balance, CFA_*/GDA_* business reverts, etc.) is fine: writes are called
// from an unfunded TEST_ADDRESS and naturally revert at the contract layer.
//
// `,\s*data="0x"` anchors on the top-level CALL_EXCEPTION field separator,
// so the pattern only matches the precise empty-revert-data field at the
// top of the error -- not e.g. a nested transaction's `"data": "0x..."`
// (which uses JSON `"key": value` with a colon, not `key=value` with =).
// The closing quote immediately after `0x` is the precise signature:
// real reverts have hex content between the quotes (`data="0x08c..."`).
const DISPATCH_FAILURE_RE =
  /INVALID_ARGUMENT|could not decode|invalid function|missing revert data|,\s*data="0x"/;

// The "missing revert data" alternative above is genuinely ambiguous.
// ethers 6.16.0 only ever produces that text with `data=null` and
// `reason=null` (no code path in that version produces it otherwise), and
// it reports it identically for two very different situations: the real
// misroute regression (see "reroute regression" below), and a Sepolia RPC
// endpoint that withheld revert data while degraded/rate-limited. The
// message text alone cannot tell them apart -- `resolveEstimateGasError`
// below corroborates this one shape against a second, independent endpoint
// before trusting it as a real dispatch failure. Every other
// DISPATCH_FAILURE_RE alternative is already unambiguous and needs no such
// corroboration.
//
// Checked on the typed error fields rather than the stringified message:
// mirrors tests/integration/_shared/onchain-rpc.ts's isRpcInfraError,
// which classifies this identical shape (CALL_EXCEPTION with no execution
// data) as RPC-infra noise for the same reason. A future ethers version
// that reformats CALL_EXCEPTION's message text would silently break a
// string/regex check; the typed fields are the stable contract.
type EthersLikeError = { code?: string; data?: unknown; reason?: unknown };

function isAmbiguousMissingRevertData(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const e = error as EthersLikeError;
  return e.code === "CALL_EXCEPTION" && e.data == null && e.reason == null;
}

/**
 * Resolves the outcome of an estimateGas attempt given a primary attempt
 * (through the shared failover manager, as before this fallback
 * corroboration was added) and an independent fallback attempt.
 *
 * `RpcProviderManager.executeWithFailover` treats CALL_EXCEPTION (which
 * "missing revert data" is) as non-retryable and throws immediately,
 * bypassing both its retry loop and its failover logic entirely -- see
 * `NON_RETRYABLE_ERROR_CODES` / `isNonRetryableError` in
 * lib/rpc/providers/error-classification.ts. That is correct for every
 * other caller of that shared code: a genuine contract revert on one
 * endpoint is a revert on any endpoint, so retrying elsewhere is pointless.
 * It also means the primary attempt below never reaches the fallback
 * endpoint on its own for this error shape.
 *
 * But the ambiguous "missing revert data" shape specifically can also mean
 * the endpoint withheld revert data rather than the contract genuinely
 * rejecting the call. So only for that one shape, this function makes an
 * explicit second call directly against the fallback endpoint -- bypassing
 * `manager`/`executeWithFailover` entirely -- and uses that outcome as the
 * final answer: a clean fallback result means the primary error was RPC
 * noise (returns "", matching estimateGasError's existing "no failure"
 * contract); a fallback error means two independent endpoints agree, which
 * is a real signal and must still surface as a failure. Any other,
 * unambiguous error shape is returned immediately with no second call.
 */
async function resolveEstimateGasError(
  primaryAttempt: () => Promise<unknown>,
  fallbackAttempt: () => Promise<unknown>
): Promise<string> {
  try {
    await primaryAttempt();
    return "";
  } catch (error) {
    if (!isAmbiguousMissingRevertData(error)) {
      return String(error);
    }
    try {
      await fallbackAttempt();
      return "";
    } catch (fallbackError) {
      return String(fallbackError);
    }
  }
}

describe("Superfluid on-chain integration", () => {
  let manager: RpcProviderManager;

  beforeAll(async () => {
    manager = await getRpcProviderFromUrls(
      SEPOLIA_PRIMARY_URL,
      SEPOLIA_FALLBACK_URL,
      SEPOLIA_CHAIN_ID,
      "sepolia"
    );
  });

  // -- helpers -------------------------------------------------------------

  async function callAndDecode(
    slug: string,
    inputs: Record<string, string>,
    contractAddressOverride?: string
  ): Promise<{
    decoded: ethers.Result;
    contract: ProtocolContract;
    action: ProtocolAction;
    to: string;
  }> {
    const { to, data, contract, action } = buildCalldata({
      protocol: superfluidDef,
      actionSlug: slug,
      sampleInputs: inputs,
      chainId: CHAIN_ID,
      toOverride: contractAddressOverride,
    });
    const result = await manager.executeWithFailover((p) =>
      p.call({ to, data })
    );
    const abi = JSON.parse(contract.abi as string);
    const iface = new ethers.Interface(abi);
    const decoded = iface.decodeFunctionResult(action.function, result);
    return { decoded, contract, action, to };
  }

  // Returns the error message from estimateGas, or "" if it succeeded.
  // Callers either assert the empty string (positive simulation) or assert
  // the message does not match DISPATCH_FAILURE_RE (any non-routing-error
  // revert is acceptable). See resolveEstimateGasError above for the
  // fallback corroboration this delegates to for the ambiguous "missing
  // revert data" shape.
  async function estimateGasError(
    slug: string,
    inputs: Record<string, string>,
    contractAddressOverride?: string
  ): Promise<string> {
    const { to, data } = buildCalldata({
      protocol: superfluidDef,
      actionSlug: slug,
      sampleInputs: inputs,
      chainId: CHAIN_ID,
      toOverride: contractAddressOverride,
    });
    return resolveEstimateGasError(
      () =>
        manager.executeWithFailover((p) =>
          p.estimateGas({ to, data, from: TEST_ADDRESS })
        ),
      () => {
        // manager may already be in its sticky fallback state from an
        // earlier call in this suite (a degraded-RPC run is exactly when
        // that happens) -- when it is, the primary attempt above actually
        // queried SEPOLIA_FALLBACK_URL, so corroborating against that same
        // URL again would be a same-node retry, not a second opinion.
        // Target whichever endpoint the primary attempt did not just use.
        const corroborationUrl = manager.isCurrentlyUsingFallback()
          ? SEPOLIA_PRIMARY_URL
          : SEPOLIA_FALLBACK_URL;
        const fetchRequest = new ethers.FetchRequest(corroborationUrl);
        fetchRequest.timeout = 5000;
        fetchRequest.getUrlFunc = safeEthersGetUrl;
        return new ethers.JsonRpcProvider(
          fetchRequest,
          ethers.Network.from(SEPOLIA_CHAIN_ID),
          { staticNetwork: true }
        ).estimateGas({ to, data, from: TEST_ADDRESS });
      }
    );
  }

  // -- CFA reads -----------------------------------------------------------

  itOnchain(
    "get-flow: returns the four expected CFA flow-info outputs",
    async () => {
      const { decoded, to } = await callAndDecode("get-flow", {
        token: SEPOLIA_FUSDCX,
        sender: TEST_ADDRESS,
        receiver: TEST_ADDRESS,
      });
      expect(to).toBe(CFA_FORWARDER_ADDRESS);
      expect(decoded).toHaveLength(4);
    },
    15_000
  );

  itOnchain(
    "get-cfa-net-flow: dispatches to cfaForwarder.getAccountFlowrate",
    async () => {
      const { decoded, to } = await callAndDecode("get-cfa-net-flow", {
        token: SEPOLIA_FUSDCX,
        account: TEST_ADDRESS,
      });
      expect(to).toBe(CFA_FORWARDER_ADDRESS);
      expect(typeof decoded[0]).toBe("bigint");
    },
    15_000
  );

  // -- GDA reads -----------------------------------------------------------

  itOnchain(
    "get-net-flow: dispatches to gdaForwarder.getNetFlow (combined CFA+GDA)",
    async () => {
      const { decoded, to } = await callAndDecode("get-net-flow", {
        token: SEPOLIA_FUSDCX,
        account: TEST_ADDRESS,
      });
      expect(to).toBe(GDA_FORWARDER_ADDRESS);
      expect(typeof decoded[0]).toBe("bigint");
    },
    15_000
  );

  // -- SuperToken reads (userSpecifiedAddress) -----------------------------

  itOnchain(
    "get-super-token-balance: dispatches to the user-supplied SuperToken",
    async () => {
      const { decoded } = await callAndDecode(
        "get-super-token-balance",
        { account: TEST_ADDRESS },
        SEPOLIA_FUSDCX
      );
      expect(typeof decoded[0]).toBe("bigint");
    },
    15_000
  );

  itOnchain(
    "get-underlying-token: returns the fUSDC underlying for fUSDCx",
    async () => {
      const { decoded } = await callAndDecode(
        "get-underlying-token",
        {},
        SEPOLIA_FUSDCX
      );
      expect((decoded[0] as string).toLowerCase()).toBe(
        SEPOLIA_FUSDC.toLowerCase()
      );
    },
    15_000
  );

  // -- CFA writes ----------------------------------------------------------

  itOnchain(
    "create-flow: encodes against cfaForwarder.createFlow",
    async () => {
      const msg = await estimateGasError("create-flow", {
        token: SEPOLIA_FUSDCX,
        sender: TEST_ADDRESS,
        receiver: TEST_ADDRESS,
        flowRate: DUMMY_FLOW_RATE,
        userData: DUMMY_BYTES,
      });
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  itOnchain(
    "update-flow: encodes against cfaForwarder.updateFlow",
    async () => {
      const msg = await estimateGasError("update-flow", {
        token: SEPOLIA_FUSDCX,
        sender: TEST_ADDRESS,
        receiver: TEST_ADDRESS,
        flowRate: DUMMY_FLOW_RATE,
        userData: DUMMY_BYTES,
      });
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  itOnchain(
    "delete-flow: encodes against cfaForwarder.deleteFlow",
    async () => {
      const msg = await estimateGasError("delete-flow", {
        token: SEPOLIA_FUSDCX,
        sender: TEST_ADDRESS,
        receiver: TEST_ADDRESS,
        userData: DUMMY_BYTES,
      });
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  // -- GDA writes ----------------------------------------------------------

  itOnchain(
    "create-pool: simulates successfully against gdaForwarder.createPool",
    async () => {
      // GDA createPool only writes pool metadata -- no sender balance, no
      // pre-existing state required. We can assert positive simulation
      // success, which (unlike the loose .not.toMatch guard) catches the
      // class of routing bug KEEP-456 surfaced.
      const msg = await estimateGasError("create-pool", {
        token: SEPOLIA_FUSDCX,
        admin: TEST_ADDRESS,
        transferabilityForUnitsOwner: "false",
        distributionFromAnyAddress: "false",
      });
      expect(msg).toBe("");
    },
    15_000
  );

  itOnchain(
    "update-member-units: encodes against gdaForwarder.updateMemberUnits",
    async () => {
      const msg = await estimateGasError("update-member-units", {
        pool: TEST_ADDRESS,
        member: TEST_ADDRESS,
        units: DUMMY_UNITS,
        userData: DUMMY_BYTES,
      });
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  itOnchain(
    "distribute: encodes against gdaForwarder.distribute",
    async () => {
      const msg = await estimateGasError("distribute", {
        token: SEPOLIA_FUSDCX,
        from: TEST_ADDRESS,
        pool: TEST_ADDRESS,
        amount: DUMMY_AMOUNT_WEI,
        userData: DUMMY_BYTES,
      });
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  itOnchain(
    "distribute-flow: encodes int96 flowRate against gdaForwarder.distributeFlow",
    async () => {
      const msg = await estimateGasError("distribute-flow", {
        token: SEPOLIA_FUSDCX,
        from: TEST_ADDRESS,
        pool: TEST_ADDRESS,
        flowRate: DUMMY_FLOW_RATE,
        userData: DUMMY_BYTES,
      });
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  itOnchain(
    "connect-pool: encodes against gdaForwarder.connectPool",
    async () => {
      // Not convertible to toBe(""): the GDA host dispatches into the pool
      // address as a contract call during connectPool, and TEST_ADDRESS has
      // no deployed code -- so estimateGas reverts with `CallUtils: target
      // revert()`. That is not a routing/ABI failure (the revert *does*
      // have data, just from a different source), so it correctly does not
      // match DISPATCH_FAILURE_RE. Strengthening to toBe("") would need a
      // deployed contract at the pool address that implements the expected
      // pool interface (any Superfluid pool would do); out of scope for
      // "no on-chain state dependency" tests.
      const msg = await estimateGasError("connect-pool", {
        pool: TEST_ADDRESS,
        userData: DUMMY_BYTES,
      });
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  // -- SuperToken writes (userSpecifiedAddress) ----------------------------

  itOnchain(
    "wrap: encodes uint256 amount against superToken.upgrade",
    async () => {
      const msg = await estimateGasError(
        "wrap",
        { amount: DUMMY_AMOUNT_WEI },
        SEPOLIA_FUSDCX
      );
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  itOnchain(
    "unwrap: encodes uint256 amount against superToken.downgrade",
    async () => {
      const msg = await estimateGasError(
        "unwrap",
        { amount: DUMMY_AMOUNT_WEI },
        SEPOLIA_FUSDCX
      );
      expect(msg).not.toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  itOnchain(
    "grant-flow-operator: simulates successfully against cfaForwarder.updateFlowOperatorPermissions",
    async () => {
      // KEEP-456: routed through the CFAv1Forwarder, not the SuperToken proxy.
      // Asserts the call actually simulates (estimateGas returns) -- the previous
      // "tolerate any revert" pattern hid a routing bug because the SuperToken's
      // proxy reverts on the Sepolia fUSDCx test token. The CFAv1Forwarder is
      // the canonical entry point and works for any registered SuperToken.
      //
      // Note: this on-chain test is gated on INTEGRATION_TEST_RPC_URL and
      // skipped in CI. The CI-side regression guard for the routing change
      // lives in tests/unit/superfluid-protocol.test.ts ("grant-flow-operator
      // action" describe block, asserting `contract === "cfaForwarder"`).
      const msg = await estimateGasError("grant-flow-operator", {
        token: SEPOLIA_FUSDCX,
        flowOperator: TEST_OPERATOR,
        permissions: DUMMY_PERMISSIONS_ALL,
        flowRateAllowance: DUMMY_FLOW_RATE,
      });
      expect(msg).toBe("");
    },
    15_000
  );

  // -- Reroute regression --------------------------------------------------

  itOnchain(
    "reroute regression: misdispatched calldata triggers DISPATCH_FAILURE_RE",
    async () => {
      // Acceptance criterion #2 of KEEP-459: "no test passes when its
      // action is silently re-routed to a non-existent contract method."
      //
      // Reproduces the KEEP-456 failure mode end-to-end against the live
      // Sepolia RPC: take a currently-passing action (grant-flow-operator,
      // which routes correctly to the CFAv1Forwarder), then override its
      // destination to SEPOLIA_FUSDC -- a real ERC20 contract that exists
      // on chain but has no Superfluid methods. The EVM returns from the
      // dispatch with empty revert data (no fallback, no matching selector),
      // and ethers surfaces it as `missing revert data ... code=CALL_EXCEPTION`.
      //
      // If DISPATCH_FAILURE_RE is ever weakened or removed, this test fails
      // -- which is the whole point. This is the load-bearing assertion of
      // the hardening, validated against a real RPC rather than a regex
      // shape sample.
      const msg = await estimateGasError(
        "grant-flow-operator",
        {
          token: SEPOLIA_FUSDCX,
          flowOperator: TEST_OPERATOR,
          permissions: DUMMY_PERMISSIONS_ALL,
          flowRateAllowance: DUMMY_FLOW_RATE,
        },
        SEPOLIA_FUSDC
      );
      // Sanity: must not be the empty-string "simulated" case.
      expect(msg).not.toBe("");
      // The actual guard: a real misroute must surface as a dispatch failure.
      expect(msg).toMatch(DISPATCH_FAILURE_RE);
    },
    15_000
  );

  // -- Coverage check ------------------------------------------------------

  itOnchain(
    "every declared action has at least one dispatch test in this file",
    () => {
      const declared = new Set(superfluidDef.actions.map((a) => a.slug));
      const tested = new Set([
        "get-flow",
        "get-cfa-net-flow",
        "get-net-flow",
        "get-super-token-balance",
        "get-underlying-token",
        "create-flow",
        "update-flow",
        "delete-flow",
        "create-pool",
        "update-member-units",
        "distribute",
        "distribute-flow",
        "connect-pool",
        "wrap",
        "unwrap",
        "grant-flow-operator",
      ]);
      const missing = [...declared].filter((s) => !tested.has(s));
      const stale = [...tested].filter((s) => !declared.has(s));
      expect(missing).toEqual([]);
      expect(stale).toEqual([]);
    }
  );
});

// Not gated on RPC: validates the regex shape that the on-chain block above
// relies on to catch routing regressions like KEEP-456 (calling into a
// non-existent proxy returns no revert data). Each case synthesizes a real
// ethers error via `ethers.makeError` rather than pinning a hardcoded
// string -- if ethers changes its error formatting in a future major,
// these tests fail loudly instead of silently validating a stale shape.
describe("DISPATCH_FAILURE_RE shape (synthesized ethers errors)", () => {
  // estimateGasError wraps caught errors with `String(error)`, so the
  // assertion target is the .toString() of the ethers error, prefixed
  // with the constructor name (e.g. "Error: ..." or "TypeError: ...").
  function asMessage(err: Error): string {
    return String(err);
  }

  itOnchain("matches `missing revert data` (revert: null branch)", () => {
    const err = ethers.makeError("missing revert data", "CALL_EXCEPTION", {
      action: "estimateGas",
      data: null,
      reason: null,
      transaction: { data: "0xdeadbeef", from: TEST_ADDRESS, to: TEST_ADDRESS },
      invocation: null,
      revert: null,
    });
    expect(asMessage(err)).toMatch(DISPATCH_FAILURE_RE);
  });

  itOnchain(
    'matches empty revert data="0x" (proxy returned no revert data)',
    () => {
      const err = ethers.makeError("execution reverted", "CALL_EXCEPTION", {
        action: "estimateGas",
        data: "0x",
        reason: null,
        transaction: { data: "0xdeadbeef", to: TEST_ADDRESS },
        invocation: null,
        revert: null,
      });
      expect(asMessage(err)).toMatch(DISPATCH_FAILURE_RE);
    }
  );

  itOnchain(
    'does NOT misfire on data="0x..." with actual revert payload',
    () => {
      // Guards against the obvious regression of writing `/data="0x/`
      // (no closing quote), which would match every revert.
      const err = ethers.makeError(
        'execution reverted: "X"',
        "CALL_EXCEPTION",
        {
          action: "estimateGas",
          data: "0x08c379a0deadbeef",
          reason: "X",
          transaction: { data: "0xdeadbeef", to: TEST_ADDRESS },
          invocation: null,
          revert: { args: ["X"], name: "Error", signature: "Error(string)" },
        }
      );
      expect(asMessage(err)).not.toMatch(DISPATCH_FAILURE_RE);
    }
  );

  itOnchain("matches ABI encoding errors (INVALID_ARGUMENT)", () => {
    const err = ethers.makeError(
      "invalid BigNumberish value",
      "INVALID_ARGUMENT",
      { argument: "value", value: "abc" }
    );
    expect(asMessage(err)).toMatch(DISPATCH_FAILURE_RE);
  });

  itOnchain(
    'does NOT misfire when only the nested transaction.data is "0x"',
    () => {
      // Defense-in-depth: confirms the `,\s*data="0x"` anchor distinguishes
      // top-level CALL_EXCEPTION fields (key=value) from nested JSON
      // (`"key": value`). If a future ethers version (or a quirky calldata)
      // ever produced a transaction object whose data was literally "0x"
      // while the top-level data was populated, the old `data="0x"` pattern
      // would have false-positived. The anchor prevents that.
      const err = ethers.makeError(
        'execution reverted: "X"',
        "CALL_EXCEPTION",
        {
          action: "estimateGas",
          data: "0x08c379a0deadbeef",
          reason: "X",
          // Nested transaction with empty data (hypothetical fallback call):
          transaction: { data: "0x", to: TEST_ADDRESS },
          invocation: null,
          revert: { args: ["X"], name: "Error", signature: "Error(string)" },
        }
      );
      expect(asMessage(err)).not.toMatch(DISPATCH_FAILURE_RE);
    }
  );

  itOnchain(
    "does NOT match a normal business revert with populated revert data",
    () => {
      // Models the real connect-pool revert against an EOA "pool": the GDA
      // dispatches into the address and gets `CallUtils: target revert()`.
      // Contract was reached, revert has data -- tolerate, do not flag as
      // a routing/dispatch bug.
      const err = ethers.makeError(
        'execution reverted: "CallUtils: target revert()"',
        "CALL_EXCEPTION",
        {
          action: "estimateGas",
          data: "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001a43616c6c5574696c733a20746172676574207265766572742829000000000000",
          reason: "CallUtils: target revert()",
          transaction: { data: "0xdeadbeef", to: TEST_ADDRESS },
          invocation: null,
          revert: {
            args: ["CallUtils: target revert()"],
            name: "Error",
            signature: "Error(string)",
          },
        }
      );
      expect(asMessage(err)).not.toMatch(DISPATCH_FAILURE_RE);
    }
  );
});

// Unit-level coverage for resolveEstimateGasError's fallback
// corroboration, mocking the primary/fallback attempts directly rather than
// hitting a live RPC -- same reasoning as the "DISPATCH_FAILURE_RE shape"
// block above (synthesized ethers errors instead of a real endpoint).
describe("resolveEstimateGasError (fallback corroboration for ambiguous missing revert data)", () => {
  function missingRevertDataError(): Error {
    return ethers.makeError("missing revert data", "CALL_EXCEPTION", {
      action: "estimateGas",
      data: null,
      reason: null,
      transaction: {
        data: "0xdeadbeef",
        from: TEST_ADDRESS,
        to: TEST_ADDRESS,
      },
      invocation: null,
      revert: null,
    });
  }

  itOnchain(
    "ambiguous primary failure + clean fallback -> resolves as no dispatch failure",
    async () => {
      const primaryAttempt = vi
        .fn()
        .mockRejectedValue(missingRevertDataError());
      const fallbackAttempt = vi.fn().mockResolvedValue(BigInt(21_000));

      const result = await resolveEstimateGasError(
        primaryAttempt,
        fallbackAttempt
      );

      expect(result).toBe("");
      expect(fallbackAttempt).toHaveBeenCalledTimes(1);
    }
  );

  itOnchain(
    "ambiguous primary failure + fallback also fails -> surfaces the fallback's error and matches DISPATCH_FAILURE_RE",
    async () => {
      const primaryAttempt = vi
        .fn()
        .mockRejectedValue(missingRevertDataError());
      const fallbackError = missingRevertDataError();
      const fallbackAttempt = vi.fn().mockRejectedValue(fallbackError);

      const result = await resolveEstimateGasError(
        primaryAttempt,
        fallbackAttempt
      );

      // Two independent endpoints agreeing is a real signal, not noise.
      expect(result).toBe(String(fallbackError));
      expect(result).toMatch(DISPATCH_FAILURE_RE);
      expect(fallbackAttempt).toHaveBeenCalledTimes(1);
    }
  );

  itOnchain(
    "unambiguous primary failure (INVALID_ARGUMENT) -> returns immediately, never calls the fallback",
    async () => {
      const primaryError = ethers.makeError(
        "invalid BigNumberish value",
        "INVALID_ARGUMENT",
        { argument: "value", value: "abc" }
      );
      const primaryAttempt = vi.fn().mockRejectedValue(primaryError);
      const fallbackAttempt = vi.fn();

      const result = await resolveEstimateGasError(
        primaryAttempt,
        fallbackAttempt
      );

      expect(result).toBe(String(primaryError));
      expect(fallbackAttempt).not.toHaveBeenCalled();
    }
  );

  itOnchain(
    'unambiguous primary failure (empty revert data="0x") -> returns immediately, never calls the fallback',
    async () => {
      const primaryError = ethers.makeError(
        "execution reverted",
        "CALL_EXCEPTION",
        {
          action: "estimateGas",
          data: "0x",
          reason: null,
          transaction: { data: "0xdeadbeef", to: TEST_ADDRESS },
          invocation: null,
          revert: null,
        }
      );
      const primaryAttempt = vi.fn().mockRejectedValue(primaryError);
      const fallbackAttempt = vi.fn();

      const result = await resolveEstimateGasError(
        primaryAttempt,
        fallbackAttempt
      );

      expect(result).toBe(String(primaryError));
      expect(fallbackAttempt).not.toHaveBeenCalled();
    }
  );
});
