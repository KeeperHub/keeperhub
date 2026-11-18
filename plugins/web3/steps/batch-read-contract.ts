import "server-only";

import { ethers } from "ethers";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import {
  CALLS_FROM_ADDRESS_LIST,
  CALLS_FROM_ARGS_LIST,
  isUniformInputMode,
} from "@/plugins/web3/batch-read-modes";
import {
  ADDRESS_LIST_LABEL,
  ARGS_LIST_LABEL,
  addressError,
  addressesFromList,
  argSetsFromList,
  calldataBytes,
  checkRunCalldata,
  contractAddressFrom,
  DestinationError,
  echo,
  encodeReason,
  type ListFunction,
  MAX_REASON_LENGTH,
  MAX_TOTAL_CALLS,
  parseListInput,
  requireArguments,
  resolveCallsFrom,
  resolveListFunction,
  SHARED_ARGS_LABEL,
  sharedArgsForList,
} from "@/plugins/web3/steps/batch-read-contract-core";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "@/plugins/web3/steps/read-fail-on-error-core";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

const LOG_PREFIX = "[Batch Read Contract]";
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

type CallResult = {
  success: boolean;
  result: unknown;
  error?: string;
};

type BatchReadContractResult =
  | {
      success: true;
      // Null when failOnError=false softened a failed batch into a success
      // value so the workflow continues; `error` carries the reason. Null
      // rather than an empty list so a downstream node cannot read a failed
      // batch as "every call returned nothing". A single call reverting is
      // already isolated into its own `results` entry and is unaffected.
      results: CallResult[] | null;
      totalCalls: number | null;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

export type BatchReadContractCoreInput = ReadFailOnErrorInput & {
  network?: string;
  abi?: string;
  inputMode?: string;
  contractAddress?: string;
  abiFunction?: string;
  argsList?: string;
  calls?: string;
  batchSize?: string;
  callsFrom?: string;
  argsFromList?: string | unknown[];
  contractAddresses?: string | unknown[];
  functionArgs?: string | unknown[];
};

export type BatchReadContractInput = StepInput & BatchReadContractCoreInput;

type NormalizedCall = {
  contractAddress: string;
  abiFunction: string;
  args: unknown[];
  abi?: string;
  network?: string;
};

type EncodedCall = {
  target: string;
  allowFailure: boolean;
  callData: string;
};

type EncodedCallWithMeta = EncodedCall & {
  // Resolved once per function, so each call and result skips the lookup.
  fragment: ethers.FunctionFragment;
  iface: ethers.Interface;
  functionAbi?: { outputs?: { name?: string; type?: string }[] };
};

/**
 * Parse and validate an ABI JSON string
 */
function parseAbi(abi: string): {
  parsed: ethers.JsonFragment[];
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(abi);
  } catch (error) {
    return { parsed: [], error: `Invalid ABI JSON: ${getErrorMessage(error)}` };
  }

  if (!Array.isArray(parsed)) {
    return { parsed: [], error: "ABI must be a JSON array" };
  }

  return { parsed: parsed as ethers.JsonFragment[] };
}

/**
 * Build normalized calls from uniform mode inputs
 */
function buildUniformCalls(
  contractAddress: string,
  abiFunction: string | undefined,
  argsList: string | undefined
): { calls: NormalizedCall[]; error?: string } {
  if (!abiFunction) {
    return { calls: [], error: "Function is required. Pick one in Function." };
  }

  if (!argsList || argsList.trim() === "") {
    return {
      calls: [{ contractAddress, abiFunction, args: [] }],
    };
  }

  let parsedArgsList: unknown;
  try {
    parsedArgsList = JSON.parse(argsList);
  } catch (error) {
    return {
      calls: [],
      error: `Invalid Args List JSON: ${getErrorMessage(error)}`,
    };
  }

  if (!Array.isArray(parsedArgsList)) {
    return { calls: [], error: "Args List must be a JSON array of arg arrays" };
  }

  const normalizedCalls: NormalizedCall[] = [];
  for (const [index, argSet] of parsedArgsList.entries()) {
    if (!Array.isArray(argSet)) {
      return {
        calls: [],
        error: `Args List entry at index ${index} must be an array, got ${typeof argSet}`,
      };
    }
    normalizedCalls.push({ contractAddress, abiFunction, args: argSet });
  }

  return { calls: normalizedCalls };
}

/**
 * A mixed call's destination (network and contract address), or why it has
 * none. Checked for every call before anything else, so a bad destination
 * fails the run whatever comes first in the list.
 */
function mixedCallDestination(
  call: Record<string, unknown>,
  index: number
): { network: string; address: string } | { error: string } {
  const { network, contractAddress } = call;
  if (typeof network !== "string" || !network) {
    return {
      error: `Call ${index + 1} has no network. Pick one for this call.`,
    };
  }
  const address =
    typeof contractAddress === "string" ? contractAddress.trim() : "";
  if (!address) {
    return {
      error: `Call ${index + 1} has no Contract Address. Enter the contract to call.`,
    };
  }
  const invalid = addressError(address, `Call ${index + 1}: Contract Address`);
  return invalid ? { error: invalid } : { network, address };
}

/**
 * Validate and normalize a single call object from mixed mode input
 */
function validateMixedCall(
  typedCall: Record<string, unknown>,
  index: number,
  destination: { network: string; address: string }
):
  | { normalized: NormalizedCall; error?: undefined }
  | { normalized?: undefined; error: string } {
  const fn = typedCall.abiFunction;
  const args = typedCall.args;
  const abi = typedCall.abi;

  if (typeof fn !== "string" || !fn) {
    return { error: `Call ${index + 1} missing function.` };
  }

  if (typeof abi !== "string" || !abi) {
    return { error: `Call ${index + 1} missing ABI.` };
  }

  return {
    normalized: {
      contractAddress: destination.address,
      abiFunction: fn,
      args: Array.isArray(args) ? args : [],
      abi,
      network: destination.network,
    },
  };
}

/**
 * Build normalized calls from mixed mode inputs
 */
function buildMixedCalls(callsJson: string | undefined): {
  calls: NormalizedCall[];
  error?: string;
  destinationError?: true;
} {
  if (!callsJson || callsJson.trim() === "") {
    return { calls: [], error: "Calls JSON is required in mixed mode" };
  }

  let parsedCalls: unknown;
  try {
    parsedCalls = JSON.parse(callsJson);
  } catch (error) {
    return {
      calls: [],
      error: `Invalid Calls JSON: ${getErrorMessage(error)}`,
    };
  }

  if (!Array.isArray(parsedCalls)) {
    return { calls: [], error: "Calls must be a JSON array of call objects" };
  }

  const destinations: { network: string; address: string }[] = [];
  for (const [index, call] of parsedCalls.entries()) {
    if (typeof call !== "object" || call === null) {
      return { calls: [], error: `Call ${index + 1} must be an object` };
    }
    const destination = mixedCallDestination(
      call as Record<string, unknown>,
      index
    );
    if ("error" in destination) {
      return { calls: [], error: destination.error, destinationError: true };
    }
    destinations.push(destination);
  }

  const normalizedCalls: NormalizedCall[] = [];
  for (const [index, call] of parsedCalls.entries()) {
    const result = validateMixedCall(call, index, destinations[index]);
    if (result.error !== undefined) {
      return { calls: [], error: result.error };
    }
    normalizedCalls.push(result.normalized);
  }

  return { calls: normalizedCalls };
}

/** Recursively convert BigInt values to strings without JSON round-trip. */
function serializeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeBigInts);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeBigInts(v);
    }
    return out;
  }
  return value;
}

/**
 * Structure a decoded result based on ABI function outputs.
 *
 * decodeFunctionResult returns an N-element Result (one entry per output, no
 * auto-unwrap), so the serialized value is already the positional output list
 * that structureAbiOutputs consumes.
 */
function structureDecodedResult(
  decodedResult: ethers.Result,
  functionAbi: { outputs?: AbiOutputParam[] }
): unknown {
  const serialized = serializeBigInts(decodedResult);
  const outputs = functionAbi.outputs ?? [];
  if (outputs.length === 0) {
    return serialized;
  }
  const outputValues = Array.isArray(serialized) ? serialized : [serialized];
  return structureAbiOutputs(outputValues, outputs);
}

type ResolvedFunction = {
  fn: ListFunction;
  fragment: ethers.FunctionFragment;
};

/** The picked function and its fragment, looked up once per function. */
function resolveFunction(
  iface: ethers.Interface,
  parsedAbi: ethers.JsonFragment[],
  key: string
): ResolvedFunction {
  const fn = resolveListFunction(parsedAbi, key);
  const fragment = iface.getFunction(fn.signature);
  if (!fragment) {
    throw new Error(
      `Function '${echo(key)}' is not in the ABI. Pick it again in Function, or check the ABI.`
    );
  }
  return { fn, fragment };
}

/**
 * Encode calls for uniform mode (shared ABI)
 */
function encodeUniformCalls(
  normalizedCalls: NormalizedCall[],
  parsedAbi: ethers.JsonFragment[]
): { encoded: EncodedCallWithMeta[]; error?: string } {
  let iface: ethers.Interface;
  try {
    iface = new ethers.Interface(parsedAbi);
  } catch (error) {
    return {
      encoded: [],
      error: `Failed to parse ABI: ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`,
    };
  }

  // Every uniform call names the same function; a picked overload is stored
  // as its full signature, so resolve its fragment once and encode by it.
  const resolved = new Map<string, ResolvedFunction>();
  const encoded: EncodedCallWithMeta[] = [];
  for (const [index, call] of normalizedCalls.entries()) {
    let fn = resolved.get(call.abiFunction);
    if (!fn) {
      try {
        fn = resolveFunction(iface, parsedAbi, call.abiFunction);
      } catch (error) {
        return {
          encoded: [],
          error: getErrorMessage(error),
        };
      }
      resolved.set(call.abiFunction, fn);
    }

    try {
      const callData = iface.encodeFunctionData(fn.fragment, call.args);
      encoded.push({
        target: call.contractAddress,
        allowFailure: true,
        callData,
        fragment: fn.fragment,
        iface,
        functionAbi: { outputs: fn.fn.outputs },
      });
    } catch (error) {
      return {
        encoded: [],
        error: `Failed to encode call ${index + 1} (${call.abiFunction}): ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`,
      };
    }
  }

  return { encoded };
}

/**
 * Encode calls for mixed mode (per-call ABI)
 */
function encodeMixedCalls(normalizedCalls: NormalizedCall[]): {
  encoded: EncodedCallWithMeta[];
  error?: string;
} {
  const encoded: EncodedCallWithMeta[] = [];

  for (const [index, call] of normalizedCalls.entries()) {
    if (!call.abi) {
      return {
        encoded: [],
        error: `Call ${index + 1} missing ABI.`,
      };
    }

    const { parsed: callAbi, error: abiError } = parseAbi(call.abi);
    if (abiError) {
      return {
        encoded: [],
        error: `Call ${index + 1}: ${abiError}`,
      };
    }

    let iface: ethers.Interface;
    try {
      iface = new ethers.Interface(callAbi);
    } catch (error) {
      return {
        encoded: [],
        error: `Call ${index + 1}: Failed to parse ABI: ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`,
      };
    }

    // A picked overload is stored as its full signature; encode by it.
    let fn: ResolvedFunction;
    try {
      fn = resolveFunction(iface, callAbi, call.abiFunction);
    } catch (error) {
      return {
        encoded: [],
        error: `Call ${index + 1}: ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`,
      };
    }

    try {
      const callData = iface.encodeFunctionData(fn.fragment, call.args);
      encoded.push({
        target: call.contractAddress,
        allowFailure: true,
        callData,
        fragment: fn.fragment,
        iface,
        functionAbi: { outputs: fn.fn.outputs },
      });
    } catch (error) {
      return {
        encoded: [],
        error: `Failed to encode call ${index + 1} (${call.abiFunction}): ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`,
      };
    }
  }

  return { encoded };
}

/**
 * Decode a single multicall result entry
 */
function decodeCallResult(
  callSuccess: boolean,
  returnData: string,
  callMeta: EncodedCallWithMeta
): CallResult {
  if (!callSuccess) {
    let revertReason = "Call reverted";
    try {
      const decoded = callMeta.iface.parseError(returnData);
      if (decoded) {
        revertReason = `Call reverted: ${echo(`${decoded.name}(${decoded.args.join(", ")})`, MAX_REASON_LENGTH)}`;
      }
    } catch {
      if (returnData && returnData !== "0x") {
        try {
          const reason = ethers.AbiCoder.defaultAbiCoder().decode(
            ["string"],
            ethers.dataSlice(returnData, 4)
          );
          revertReason = `Call reverted: ${echo(String(reason[0]), MAX_REASON_LENGTH)}`;
        } catch {
          // Raw bytes
        }
      }
    }
    return { success: false, result: null, error: revertReason };
  }

  try {
    const decoded = callMeta.iface.decodeFunctionResult(
      callMeta.fragment,
      returnData
    );
    const structured = callMeta.functionAbi
      ? structureDecodedResult(decoded, callMeta.functionAbi)
      : serializeBigInts(decoded);
    return { success: true, result: structured };
  } catch (error) {
    return {
      success: false,
      result: null,
      error: `Failed to decode result: ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`,
    };
  }
}

/**
 * Execute a batch of encoded calls via Multicall3 on a single chain
 */
async function executeMulticallBatches(
  encodedCalls: EncodedCallWithMeta[],
  rpcManager: RpcProviderManager,
  batchSize: number,
  chainId: number
): Promise<{ results: CallResult[]; error?: string }> {
  const results: CallResult[] = [];
  const totalBatches = Math.ceil(encodedCalls.length / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, encodedCalls.length);
    const batch = encodedCalls.slice(batchStart, batchEnd);

    const multicallInput = batch.map(({ target, allowFailure, callData }) => ({
      target,
      allowFailure,
      callData,
    }));

    try {
      const batchResults = await rpcManager.executeWithFailover((provider) => {
        const multicall = new ethers.Contract(
          MULTICALL3_ADDRESS,
          MULTICALL3_ABI,
          provider
        );
        return multicall.aggregate3.staticCall(multicallInput) as Promise<
          [boolean, string][]
        >;
      });

      for (const [i, batchResult] of batchResults.entries()) {
        const [callSuccess, returnData] = batchResult;
        const callMeta = encodedCalls[batchStart + i];
        results.push(decodeCallResult(callSuccess, returnData, callMeta));
      }
    } catch (error) {
      // An ethers error carries the whole batch's call data; keep it short.
      const reason = echo(getErrorMessage(error), MAX_REASON_LENGTH);
      const logged = new Error(reason);
      logged.name = error instanceof Error ? error.name : "Error";
      logUserError(
        ErrorCategory.NETWORK_RPC,
        `${LOG_PREFIX} Multicall batch ${batchIndex + 1} failed`,
        logged,
        {
          plugin_name: "web3",
          action_name: "batch-read-contract",
          chain_id: String(chainId),
        }
      );
      return {
        results: [],
        error: `Multicall batch ${batchIndex + 1}/${totalBatches} failed: ${reason}`,
      };
    }
  }

  return { results };
}

/**
 * Resolve chain ID and RPC provider manager for a network
 */
async function resolveChainRpc(
  network: string,
  userId: string | undefined
): Promise<
  | { chainId: number; rpcManager: RpcProviderManager; error?: undefined }
  | { chainId?: undefined; rpcManager?: undefined; error: string }
> {
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (resolveError) {
    logUserError(
      ErrorCategory.VALIDATION,
      `${LOG_PREFIX} Failed to resolve network`,
      resolveError,
      { plugin_name: "web3", action_name: "batch-read-contract" }
    );
    return { error: getErrorMessage(resolveError) };
  }

  try {
    const rpcManager = await getRpcProvider({ chainId, userId });
    return { chainId, rpcManager };
  } catch (rpcError) {
    logUserError(
      ErrorCategory.VALIDATION,
      `${LOG_PREFIX} Failed to resolve RPC config`,
      rpcError,
      {
        plugin_name: "web3",
        action_name: "batch-read-contract",
        chain_id: String(chainId),
      }
    );
    return { error: getErrorMessage(rpcError) };
  }
}

function parseBatchSize(batchSizeStr: string | undefined): number {
  if (!batchSizeStr) {
    return DEFAULT_BATCH_SIZE;
  }
  const parsed = Number.parseInt(batchSizeStr, 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.max(1, Math.min(MAX_BATCH_SIZE, parsed));
}

function logValidationError(message: string): void {
  logUserError(
    ErrorCategory.VALIDATION,
    `${LOG_PREFIX} ${message}`,
    undefined,
    {
      plugin_name: "web3",
      action_name: "batch-read-contract",
    }
  );
}

type PreparedCalls =
  | { encoded: EncodedCallWithMeta[]; error?: undefined }
  | { encoded?: undefined; error: string; destinationError?: true };

/** A failure before any call: logged, and marked when it is the destination. */
function validationFailure(
  error: string,
  destinationError?: true
): BatchReadContractResult {
  logValidationError(error);
  return destinationError
    ? { success: false, destinationError, error }
    : { success: false, error };
}

function prepareRowCalls(
  input: BatchReadContractInput,
  abi: string,
  contractAddress: string
): PreparedCalls {
  const { calls: normalizedCalls, error: callsError } = buildUniformCalls(
    contractAddress,
    input.abiFunction,
    input.argsList
  );
  if (callsError) {
    return { error: callsError };
  }
  if (normalizedCalls.length === 0) {
    return { error: "No calls to execute" };
  }
  if (normalizedCalls.length > MAX_TOTAL_CALLS) {
    return {
      error: `Too many calls (${normalizedCalls.length}). Maximum is ${MAX_TOTAL_CALLS}.`,
    };
  }
  const { parsed: parsedAbi, error: abiError } = parseAbi(abi);
  if (abiError) {
    return { error: abiError };
  }
  const encodeResult = encodeUniformCalls(normalizedCalls, parsedAbi);
  return encodeResult.error
    ? { error: encodeResult.error }
    : { encoded: encodeResult.encoded };
}

type ListContext = ResolvedFunction & {
  iface: ethers.Interface;
};

function encodeForList(
  ctx: ListContext,
  args: unknown[],
  where: string
): string {
  try {
    return ctx.iface.encodeFunctionData(ctx.fragment, args);
  } catch (error) {
    throw new Error(
      `${where} could not be encoded for ${ctx.fn.name}: ${encodeReason(error, ctx.fn)}`
    );
  }
}

function listCall(
  ctx: ListContext,
  target: string,
  callData: string
): EncodedCallWithMeta {
  return {
    target,
    allowFailure: true,
    callData,
    fragment: ctx.fragment,
    iface: ctx.iface,
    functionAbi: { outputs: ctx.fn.outputs },
  };
}

/** Same function and arguments on every address: encoded once, reused. */
function encodeAddressList(
  input: BatchReadContractInput,
  ctx: ListContext,
  addresses: string[]
): EncodedCallWithMeta[] {
  // Shaped, checked and size-bounded before it is encoded.
  const args = sharedArgsForList(input.functionArgs, ctx.fn, addresses.length);
  const callData = encodeForList(ctx, args, SHARED_ARGS_LABEL);
  checkRunCalldata(calldataBytes(callData) * addresses.length, "addresses");
  return addresses.map((target) => listCall(ctx, target, callData));
}

function encodeArgsList(
  input: BatchReadContractInput,
  ctx: ListContext,
  contractAddress: string
): EncodedCallWithMeta[] {
  requireArguments(ctx.fn);
  const entries = parseListInput(
    input.argsFromList,
    ARGS_LIST_LABEL,
    '[["0xabc..."]]'
  );
  let total = 0;
  return argSetsFromList(entries, ctx.fn).map((args, index) => {
    const callData = encodeForList(
      ctx,
      args,
      `${ARGS_LIST_LABEL} entry ${index + 1}`
    );
    total += calldataBytes(callData);
    checkRunCalldata(total, "entries");
    return listCall(ctx, contractAddress, callData);
  });
}

/** Where the calls go: one Contract Address, or every address in a list. */
type Destination = { contractAddress: string } | { addresses: string[] };

/** Calls from a list, checked entry by entry before any RPC call. */
function prepareListCalls(
  input: BatchReadContractInput,
  abi: string,
  destination: Destination
): EncodedCallWithMeta[] {
  if (!input.abiFunction) {
    throw new Error("Function is required. Pick one in Function.");
  }
  const { parsed: parsedAbi, error: abiError } = parseAbi(abi);
  if (abiError) {
    throw new Error(abiError);
  }
  let iface: ethers.Interface;
  try {
    iface = new ethers.Interface(parsedAbi);
  } catch (error) {
    throw new Error(
      `Failed to parse ABI: ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`
    );
  }
  const ctx: ListContext = {
    ...resolveFunction(iface, parsedAbi, input.abiFunction),
    iface,
  };
  return "addresses" in destination
    ? encodeAddressList(input, ctx, destination.addresses)
    : encodeArgsList(input, ctx, destination.contractAddress);
}

/**
 * Check a uniform-mode config and encode its calls. The destination (Network,
 * Contract Address or Contract Addresses) is checked first and fails as a
 * DestinationError, so Fail workflow on error off does not soften it.
 */
function prepareUniformCalls(input: BatchReadContractInput): PreparedCalls {
  try {
    if (!input.network) {
      throw new DestinationError("Network is required. Pick one in Network.");
    }
    const callsFrom = resolveCallsFrom(input.callsFrom);
    const destination: Destination =
      callsFrom === CALLS_FROM_ADDRESS_LIST
        ? {
            addresses: addressesFromList(
              parseListInput(
                input.contractAddresses,
                ADDRESS_LIST_LABEL,
                '["0xabc..."]',
                true
              )
            ),
          }
        : {
            contractAddress: contractAddressFrom(
              input.contractAddress,
              "Contract Address"
            ),
          };
    if (!input.abi) {
      const fetchFrom =
        callsFrom === CALLS_FROM_ADDRESS_LIST
          ? "Enter an address in Fetch ABI From to fetch it"
          : "Enter Contract Address to fetch it";
      throw new Error(
        `Contract ABI is required. ${fetchFrom}, or tick Use manual ABI and paste it.`
      );
    }
    if (callsFrom === CALLS_FROM_ARGS_LIST || "addresses" in destination) {
      return { encoded: prepareListCalls(input, input.abi, destination) };
    }
    return prepareRowCalls(input, input.abi, destination.contractAddress);
  } catch (error) {
    return error instanceof DestinationError
      ? { error: error.message, destinationError: true }
      : { error: getErrorMessage(error) };
  }
}

/**
 * Execute uniform mode: all calls on a single network
 */
async function executeUniformMode(
  input: BatchReadContractInput,
  userId: string | undefined
): Promise<BatchReadContractResult> {
  const prepared = prepareUniformCalls(input);
  if (prepared.error !== undefined) {
    return validationFailure(prepared.error, prepared.destinationError);
  }

  const chainRpc = await resolveChainRpc(input.network ?? "", userId);
  if (chainRpc.error !== undefined) {
    return { success: false, destinationError: true, error: chainRpc.error };
  }

  const { results, error: batchError } = await executeMulticallBatches(
    prepared.encoded,
    chainRpc.rpcManager,
    parseBatchSize(input.batchSize),
    chainRpc.chainId
  );

  if (batchError) {
    return { success: false, error: batchError };
  }

  return { success: true, results, totalCalls: results.length };
}

type IndexedEncodedCall = EncodedCallWithMeta & { originalIndex: number };

/** Group encoded calls by their network, preserving original index for re-ordering. */
function groupCallsByNetwork(
  encoded: EncodedCallWithMeta[],
  normalizedCalls: NormalizedCall[]
): Map<string, IndexedEncodedCall[]> {
  const groups = new Map<string, IndexedEncodedCall[]>();
  for (const [index, call] of encoded.entries()) {
    const network = normalizedCalls[index].network ?? "";
    const indexed: IndexedEncodedCall = { ...call, originalIndex: index };
    const group = groups.get(network);
    if (group) {
      group.push(indexed);
    } else {
      groups.set(network, [indexed]);
    }
  }
  return groups;
}

/**
 * Execute mixed mode: calls grouped by network, results merged in original order
 */
async function executeMixedMode(
  input: BatchReadContractInput,
  userId: string | undefined
): Promise<BatchReadContractResult> {
  const {
    calls: normalizedCalls,
    error: callsError,
    destinationError,
  } = buildMixedCalls(input.calls);

  if (callsError) {
    return validationFailure(callsError, destinationError);
  }

  if (normalizedCalls.length === 0) {
    return validationFailure("No calls to execute");
  }

  if (normalizedCalls.length > MAX_TOTAL_CALLS) {
    return validationFailure(
      `Too many calls (${normalizedCalls.length}). Maximum is ${MAX_TOTAL_CALLS}.`
    );
  }

  const encodeResult = encodeMixedCalls(normalizedCalls);
  if (encodeResult.error) {
    return validationFailure(encodeResult.error);
  }

  const batchSize = parseBatchSize(input.batchSize);
  const networkGroups = groupCallsByNetwork(
    encodeResult.encoded,
    normalizedCalls
  );

  type GroupSuccess = {
    ok: true;
    results: CallResult[];
    group: IndexedEncodedCall[];
  };
  type GroupFailure = { ok: false; error: string; destinationError?: true };
  type GroupOutcome = GroupSuccess | GroupFailure;

  // Execute all network groups in parallel
  const allResults: CallResult[] = new Array(normalizedCalls.length);
  const groupEntries = [...networkGroups.entries()];

  const groupOutcomes: GroupOutcome[] = await Promise.all(
    groupEntries.map(async ([networkKey, group]): Promise<GroupOutcome> => {
      const chainRpc = await resolveChainRpc(networkKey, userId);
      if (chainRpc.error !== undefined) {
        return { ok: false, error: chainRpc.error, destinationError: true };
      }

      const batchResult = await executeMulticallBatches(
        group,
        chainRpc.rpcManager,
        batchSize,
        chainRpc.chainId
      );
      if (batchResult.error !== undefined) {
        return { ok: false, error: batchResult.error };
      }

      return { ok: true, results: batchResult.results, group };
    })
  );

  for (const outcome of groupOutcomes) {
    if (!outcome.ok) {
      return outcome.destinationError
        ? { success: false, destinationError: true, error: outcome.error }
        : { success: false, error: outcome.error };
    }
    for (const [resultIdx, groupCall] of outcome.group.entries()) {
      allResults[groupCall.originalIndex] = outcome.results[resultIdx];
    }
  }

  return { success: true, results: allResults, totalCalls: allResults.length };
}

/**
 * Core batch read contract step handler
 */
async function stepHandler(
  input: BatchReadContractInput
): Promise<BatchReadContractResult> {
  const userId = await getRpcPreferenceUserId(input._context?.executionId);
  if (isUniformInputMode(input.inputMode)) {
    return await executeUniformMode(input, userId);
  }

  return await executeMixedMode(input, userId);
}

/**
 * Batch Read Contract Step
 * Calls the same or different contract functions in a single RPC call using Multicall3
 */
export async function batchReadContractStep(
  input: BatchReadContractInput
): Promise<BatchReadContractResult> {
  "use step";

  return runPluginStep(
    { pluginName: "web3", actionName: "batch-read-contract" },
    input,
    async (i) =>
      applyReadFailOnError(await stepHandler(i), i.failOnError, {
        results: null,
        totalCalls: null,
      })
  );
}

batchReadContractStep.maxRetries = 0;

export const _integrationType = "web3";
