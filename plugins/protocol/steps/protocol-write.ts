import "server-only";
import "@/protocols";

import { ethers } from "ethers";
import {
  type WriteContractCoreInput,
  type WriteContractResult,
  writeContractCore,
} from "@/plugins/web3/steps/write-contract-core";
import { resolveAbi } from "@/lib/abi/cache";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import { withStepValueCap } from "@/lib/execute/value-ledger";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getProtocol,
  type ProtocolAction,
  resolveContractAddress,
} from "@/lib/protocol-registry";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  applyEncodeTransformsNamed,
  getEncodeTransform,
} from "@/lib/protocol-encode-transforms";
import {
  type ProtocolMeta,
  resolveProtocolMeta,
} from "./resolve-protocol-meta";

type ProtocolWriteInput = StepInput & {
  network: string;
  contractAddress?: string;
  gasLimitMultiplier?: string;
  // KEEP-137: Private mempool routing (Flashbots Protect). Forwarded to writeContractCore.
  usePrivateMempool?: boolean;
  strict?: boolean;
  _protocolMeta?: string;
  _actionType?: string;
  [key: string]: unknown;
};

const UNISWAP_PAYABLE_SWAP_FUNCTIONS: ReadonlySet<string> = new Set([
  "exactInputSingle",
  "exactOutputSingle",
]);

type PreflightResult =
  | { ok: true }
  | { ok: false; error: string };

function resolveEthValue(
  rawEthValue: unknown,
  abi: string,
  functionName: string,
  protocolSlug: string
): string | undefined {
  if (typeof rawEthValue !== "string" || rawEthValue.trim() === "") {
    return undefined;
  }
  const trimmed = rawEthValue.trim();

  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch {
    return trimmed;
  }
  if (!Array.isArray(parsedAbi)) {
    return trimmed;
  }

  // Drop ethValue when the resolved function is positively non-payable. Form
  // state can retain stale ethValue from a previous payable configuration
  // when the user reconfigures the action to a non-payable target (e.g. a
  // WETH.deposit action reconfigured into Compound.supply). Letting the
  // value through would either revert on-chain with an opaque "function is
  // not payable" or, worse, get masked by RPC simulation. If the function is
  // missing from the ABI or its mutability is unknown, pass the value
  // through and let writeContractCore's existing payable/not-found errors
  // surface.
  const fn = findAbiFunction(parsedAbi as AbiItem[], functionName);
  if (fn?.stateMutability && fn.stateMutability !== "payable") {
    logUserError(
      ErrorCategory.CONFIGURATION,
      `[Protocol Write] Dropped ethValue for non-payable function '${functionName}' (was '${trimmed}')`,
      undefined,
      {
        plugin_name: "protocol",
        action_name: "protocol-write",
        protocol_slug: protocolSlug,
        function_name: functionName,
        state_mutability: fn.stateMutability,
      }
    );
    return undefined;
  }
  return trimmed;
}

// KEEP-408: Uniswap swap functions are `payable` so SwapRouter02 can wrap
// msg.value into WETH internally - but only when tokenIn IS the chain's WETH
// address. Setting ETH Value with any other tokenIn strands the ETH in the
// router (the contract has no way to refund it without an explicit refundETH
// in a multicall, which we don't expose). Catch this before the tx is sent.
//
// Runs before ABI resolution: it only needs `network`, raw `ethValue`, and
// raw `tokenIn`, so a misconfigured swap fails fast without paying for an
// Etherscan ABI fetch on the user-specified-address path.
//
// Note the seam: this is the one ethValue consumer that reads the field
// *before* applyEthValueTransform, so it sees the user's raw units. That is
// harmless today - it only asks "is this zero" and compares tokenIn - and
// both answers survive a wei-to-ether conversion, since a value is zero in
// either unit or neither. It stops being harmless the moment this preflight
// grows a threshold or an amount comparison. If that happens, move it after
// the transform rather than teaching it about units.
function checkUniswapNativeEthPreflight(
  input: ProtocolWriteInput,
  meta: ProtocolMeta
): PreflightResult {
  const isUniswapSwap =
    meta.protocolSlug === "uniswap" &&
    UNISWAP_PAYABLE_SWAP_FUNCTIONS.has(meta.functionName);
  if (!isUniswapSwap) {
    return { ok: true };
  }

  const rawEthValue = input.ethValue;
  if (typeof rawEthValue !== "string" || rawEthValue.trim() === "") {
    return { ok: true };
  }

  // Use parseEther for the zero check rather than a regex: the regex would
  // false-positive on inputs like "00", ".0", or "0.0e0" by treating them as
  // non-zero, even though the downstream parseEther sees them as zero (or
  // throws). Letting parseEther decide makes the preflight semantics match
  // what actually reaches the contract.
  let parsedEthValue: bigint;
  try {
    parsedEthValue = ethers.parseEther(rawEthValue.trim());
  } catch {
    // Malformed value - let writeContractCore's existing parseEther guard
    // produce the canonical "Invalid payable value" error rather than
    // shadowing it with a misleading WETH-address error.
    return { ok: true };
  }
  if (parsedEthValue === BigInt(0)) {
    return { ok: true };
  }

  const wrapped = getProtocol("wrapped");
  const wethAddress = wrapped?.contracts.weth?.addresses[input.network];
  if (!wethAddress) {
    return {
      ok: false,
      error: `ETH Value is set but the WETH address for chain "${input.network}" is not registered. Cannot verify that this swap accepts native ETH; remove ETH Value or add WETH for this chain in protocols/wrapped.ts.`,
    };
  }

  const tokenIn = input.tokenIn;
  if (typeof tokenIn !== "string" || tokenIn.trim() === "") {
    return {
      ok: false,
      error:
        "ETH Value is set but Input Token Address is missing. To swap native ETH, set Input Token to the WETH address for this chain.",
    };
  }

  if (tokenIn.trim().toLowerCase() !== wethAddress.toLowerCase()) {
    return {
      ok: false,
      error: `ETH Value is set but Input Token (${tokenIn}) is not the WETH address for chain "${input.network}" (${wethAddress}). To swap native ETH, set Input Token to the WETH address; otherwise the ETH would be stranded in SwapRouter02.`,
    };
  }

  return { ok: true };
}

// Both the args builder and the ethValue transform pass need the action the
// step is executing. Resolved here once so the two paths cannot drift into
// different lookup rules.
function findProtocolAction(meta: ProtocolMeta): ProtocolAction | undefined {
  return getProtocol(meta.protocolSlug)?.actions.find(
    (a) => a.function === meta.functionName && a.contract === meta.contractKey
  );
}

function buildFunctionArgs(
  input: ProtocolWriteInput,
  meta: ProtocolMeta
): string | undefined {
  const protocolAction = findProtocolAction(meta);
  if (!protocolAction || protocolAction.inputs.length === 0) {
    return undefined;
  }

  const rawInputs = protocolAction.inputs.map((inp) => {
    const raw = input[inp.name];
    if (raw === undefined || raw === "") {
      return { name: inp.name, value: inp.default ?? "" };
    }
    const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    return { name: inp.name, value };
  });

  const actionSlug = protocolAction.slug;
  const transformed = applyEncodeTransformsNamed(
    meta.protocolSlug,
    actionSlug,
    rawInputs
  );

  const args = transformed.map((t) => t.value);
  return JSON.stringify(args);
}

type EthValueTransformResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

// The ETH Value field is a virtual input resolved on its own path, so the
// per-input transform pass inside buildFunctionArgs never sees it. A
// transform registered under the input name "ethValue" is applied here,
// before resolveEthValue, so the converted value reaches both consumers:
// the core write and the org daily-value cap. The documented unit of the
// field stays ether; a registered transform converts into it.
//
// This fails closed on an unresolvable action, and that is the point. The
// lookup runs against `meta`, which resolve-protocol-meta.ts casts out of
// an unvalidated JSON.parse of the node's stored `_protocolMeta`, so a
// contractKey or functionName that no longer matches a registered action
// resolves to nothing. Passing the value through in that case would hand
// resolveEthValue a raw wei integer that parseEther reads as ether -
// 10^18 times the intended amount. The daily-value cap normally refuses
// such a number, but value-ledger.ts returns run() uncapped when a
// reservation is already held or the organizationId is absent, so on
// those paths it would reach the wallet and fail only on balance. There
// is no safe default here: without the action we cannot know whether the
// field needs converting, so we refuse rather than guess.
function applyEthValueTransform(
  rawEthValue: unknown,
  meta: ProtocolMeta
): EthValueTransformResult {
  if (typeof rawEthValue !== "string" || rawEthValue.trim() === "") {
    return { ok: true, value: rawEthValue };
  }
  const protocolAction = findProtocolAction(meta);
  if (!protocolAction) {
    // Logged as well as returned: this turns a previously-succeeding
    // execution into a hard failure for a zero-argument payable action
    // whose _protocolMeta has drifted, and without a log the affected
    // nodes are only findable when a user reports one.
    logUserError(
      ErrorCategory.CONFIGURATION,
      `[Protocol Write] Refused a payable value: no action matches function '${meta.functionName}' on contract '${meta.contractKey}' in protocol '${meta.protocolSlug}'`,
      undefined,
      {
        plugin_name: "protocol",
        action_name: "protocol-write",
        protocol_slug: meta.protocolSlug,
        function_name: meta.functionName,
        contract_key: meta.contractKey,
      }
    );
    return {
      ok: false,
      error: `Refusing to send a payable value: no action matches function "${meta.functionName}" on contract "${meta.contractKey}" in protocol "${meta.protocolSlug}", so whether the ETH Value field needs a unit conversion cannot be determined. This usually means the step's stored protocol metadata is stale - re-select the action on this node.`,
    };
  }
  const transform = getEncodeTransform(
    meta.protocolSlug,
    protocolAction.slug,
    "ethValue"
  );
  return {
    ok: true,
    value: transform ? transform(rawEthValue.trim()) : rawEthValue,
  };
}

export async function protocolWriteStep(
  input: ProtocolWriteInput
): Promise<WriteContractResult> {
  "use step";

  return await withStepLogging(input, async () => {
    // 1. Resolve protocol metadata from config or action type
    const meta = resolveProtocolMeta(input);
    if (!meta) {
      return {
        success: false,
        error:
          "Invalid _protocolMeta: failed to parse JSON and could not derive from action type",
      };
    }

    // 2. Look up protocol definition from runtime registry
    const protocol = getProtocol(meta.protocolSlug);
    if (!protocol) {
      return {
        success: false,
        error: `Unknown protocol: ${meta.protocolSlug}`,
      };
    }

    // 3. Resolve contract for the selected network
    const contract = protocol.contracts[meta.contractKey];
    if (!contract) {
      return {
        success: false,
        error: `Unknown contract key "${meta.contractKey}" in protocol "${meta.protocolSlug}"`,
      };
    }

    const contractAddress = resolveContractAddress(
      contract,
      input.network,
      input.contractAddress
    );
    if (!contractAddress) {
      return {
        success: false,
        error: contract.userSpecifiedAddress
          ? `Missing contract address for "${meta.contractKey}" in protocol "${meta.protocolSlug}"`
          : `Protocol "${meta.protocolSlug}" contract "${meta.contractKey}" is not deployed on network "${input.network}"`,
      };
    }

    // Run cheap protocol-specific preflights before any network I/O so a
    // misconfigured action fails fast (no Etherscan ABI fetch, no RPC).
    const preflight = checkUniswapNativeEthPreflight(input, meta);
    if (!preflight.ok) {
      return { success: false, error: preflight.error };
    }

    // 4. Resolve ABI (from definition or auto-fetch from explorer)
    let resolvedAbi: string;
    try {
      const abiResult = await resolveAbi({
        contractAddress,
        network: input.network,
        abi: contract.abi,
      });
      resolvedAbi = abiResult.abi;
    } catch (error) {
      return {
        success: false,
        error: `Failed to resolve ABI for contract "${meta.contractKey}" in protocol "${meta.protocolSlug}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 5. Build function arguments from named inputs ordered by action definition
    const functionArgs = buildFunctionArgs(input, meta);

    // 6. Delegate to writeContractCore
    const transformedEthValue = applyEthValueTransform(input.ethValue, meta);
    if (!transformedEthValue.ok) {
      return { success: false, error: transformedEthValue.error };
    }
    const ethValue = resolveEthValue(
      transformedEthValue.value,
      resolvedAbi,
      meta.functionName,
      meta.protocolSlug
    );

    const coreInput: WriteContractCoreInput = {
      contractAddress,
      network: input.network,
      abi: resolvedAbi,
      abiFunction: meta.functionName,
      functionArgs,
      ethValue,
      gasLimitMultiplier: input.gasLimitMultiplier,
      usePrivateMempool: input.usePrivateMempool,
      strict: input.strict,
      _context: input._context
        ? {
            executionId: input._context.executionId,
          }
        : undefined,
    };

    // Charge the payable value against the org's daily cap. `ethValue` is the
    // resolved native value forwarded to writeContractCore; a non-payable /
    // absent value reserves nothing.
    return await withStepValueCap(
      {
        organizationId: input._context?.organizationId,
        stepFunction: "protocolWriteStep",
        config: { ethValue },
        executionId: input._context?.executionId,
        source: "protocol",
        valueCapReserved: input._context?.valueCapReserved,
      },
      () => writeContractCore(coreInput)
    );
  });
}

protocolWriteStep.maxRetries = 0;

export const _integrationType = "protocol";
