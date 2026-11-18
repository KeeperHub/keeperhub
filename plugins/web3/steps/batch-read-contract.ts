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
  ADDRESS_LIST_LABEL,
  ARGS_LIST_LABEL,
  addressesFromList,
  argSetsFromList,
  CALLS_FROM_ADDRESS_LIST,
  CALLS_FROM_ARGS_LIST,
  type CallsFrom,
  calldataBytes,
  checkRunCalldata,
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
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
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
  abiFunction: string;
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
  contractAddress: string | undefined,
  abiFunction: string | undefined,
  argsList: string | undefined
): { calls: NormalizedCall[]; error?: string } {
  if (!contractAddress) {
    return {
      calls: [],
      error: "Contract Address is required. Enter the contract to call.",
    };
  }

  if (!ethers.isAddress(contractAddress)) {
    return {
      calls: [],
      error: `Contract Address is not a valid address: "${echo(contractAddress)}". Use a 0x address with 40 hex characters.`,
    };
  }

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
 * Validate and normalize a single call object from mixed mode input
 */
function validateMixedCall(
  call: unknown,
  index: number
):
  | { normalized: NormalizedCall; error?: undefined }
  | { normalized?: undefined; error: string } {
  if (typeof call !== "object" || call === null) {
    return { error: `Call ${index + 1} must be an object` };
  }

  const typedCall = call as Record<string, unknown>;
  const addr = typedCall.contractAddress;
  const fn = typedCall.abiFunction;
  const args = typedCall.args;
  const abi = typedCall.abi;
  const callNetwork = typedCall.network;

  if (typeof callNetwork !== "string" || !callNetwork) {
    return { error: `Call ${index + 1} missing network` };
  }

  if (typeof addr !== "string" || !addr) {
    return { error: `Call ${index + 1} missing contractAddress` };
  }

  if (!ethers.isAddress(addr)) {
    return { error: `Call ${index + 1} has invalid address: ${addr}` };
  }

  if (typeof fn !== "string" || !fn) {
    return { error: `Call ${index + 1} missing abiFunction` };
  }

  if (typeof abi !== "string" || !abi) {
    return { error: `Call ${index + 1} missing abi` };
  }

  return {
    normalized: {
      contractAddress: addr,
      abiFunction: fn,
      args: Array.isArray(args) ? args : [],
      abi,
      network: callNetwork,
    },
  };
}

/**
 * Build normalized calls from mixed mode inputs
 */
function buildMixedCalls(callsJson: string | undefined): {
  calls: NormalizedCall[];
  error?: string;
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

  const normalizedCalls: NormalizedCall[] = [];
  for (const [index, call] of parsedCalls.entries()) {
    const result = validateMixedCall(call, index);
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
  // as its full signature, so resolve it once and encode by signature.
  const resolved = new Map<string, ListFunction>();
  const encoded: EncodedCallWithMeta[] = [];
  for (const [index, call] of normalizedCalls.entries()) {
    let fn = resolved.get(call.abiFunction);
    if (!fn) {
      try {
        fn = resolveListFunction(parsedAbi, call.abiFunction);
      } catch (error) {
        return {
          encoded: [],
          error: getErrorMessage(error),
        };
      }
      resolved.set(call.abiFunction, fn);
    }

    try {
      const callData = iface.encodeFunctionData(fn.signature, call.args);
      encoded.push({
        target: call.contractAddress,
        allowFailure: true,
        callData,
        abiFunction: fn.signature,
        iface,
        functionAbi: { outputs: fn.outputs },
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
        error: `Call ${index + 1} missing ABI`,
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
    let fn: ListFunction;
    try {
      fn = resolveListFunction(callAbi, call.abiFunction);
    } catch (error) {
      return {
        encoded: [],
        error: `Call ${index + 1}: ${getErrorMessage(error)}`,
      };
    }

    try {
      const callData = iface.encodeFunctionData(fn.signature, call.args);
      encoded.push({
        target: call.contractAddress,
        allowFailure: true,
        callData,
        abiFunction: fn.signature,
        iface,
        functionAbi: { outputs: fn.outputs },
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
      callMeta.abiFunction,
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
  | { encoded?: undefined; error: string };

function prepareRowCalls(
  input: BatchReadContractInput,
  abi: string
): PreparedCalls {
  const { calls: normalizedCalls, error: callsError } = buildUniformCalls(
    input.contractAddress,
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

type ListContext = {
  fn: ListFunction;
  iface: ethers.Interface;
};

function encodeForList(
  ctx: ListContext,
  args: unknown[],
  where: string
): string {
  try {
    return ctx.iface.encodeFunctionData(ctx.fn.signature, args);
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
    abiFunction: ctx.fn.signature,
    iface: ctx.iface,
    functionAbi: { outputs: ctx.fn.outputs },
  };
}

/** Same function and arguments on every address: encoded once, reused. */
function encodeAddressList(
  input: BatchReadContractInput,
  ctx: ListContext
): EncodedCallWithMeta[] {
  const addresses = addressesFromList(
    parseListInput(input.contractAddresses, ADDRESS_LIST_LABEL, '["0xabc..."]')
  );
  // Bounded before encoding inside: encoding a large argument is itself slow.
  const args = sharedArgsForList(input.functionArgs, ctx.fn, addresses.length);
  const callData = encodeForList(ctx, args, SHARED_ARGS_LABEL);
  checkRunCalldata(calldataBytes(callData) * addresses.length, "addresses");
  return addresses.map((target) => listCall(ctx, target, callData));
}

function encodeArgsList(
  input: BatchReadContractInput,
  ctx: ListContext
): EncodedCallWithMeta[] {
  const contractAddress = input.contractAddress?.trim();
  if (!contractAddress) {
    throw new Error(
      "Contract Address is required. Enter the contract to call."
    );
  }
  if (!HEX_ADDRESS_RE.test(contractAddress)) {
    throw new Error(
      `Contract Address is not a valid address: "${echo(contractAddress)}". Use a 0x address with 40 hex characters.`
    );
  }
  if (!ethers.isAddress(contractAddress)) {
    throw new Error(
      `Contract Address has a bad checksum: "${contractAddress}". Use the address exactly as published, or in all lower case.`
    );
  }
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

/** Calls from a list, checked entry by entry before any RPC call. */
function prepareListCalls(
  input: BatchReadContractInput,
  abi: string,
  callsFrom: typeof CALLS_FROM_ARGS_LIST | typeof CALLS_FROM_ADDRESS_LIST
): PreparedCalls {
  if (!input.abiFunction) {
    return { error: "Function is required. Pick one in Function." };
  }
  const { parsed: parsedAbi, error: abiError } = parseAbi(abi);
  if (abiError) {
    return { error: abiError };
  }
  let iface: ethers.Interface;
  try {
    iface = new ethers.Interface(parsedAbi);
  } catch (error) {
    return {
      error: `Failed to parse ABI: ${echo(getErrorMessage(error), MAX_REASON_LENGTH)}`,
    };
  }
  try {
    const ctx: ListContext = {
      fn: resolveListFunction(parsedAbi, input.abiFunction),
      iface,
    };
    return {
      encoded:
        callsFrom === CALLS_FROM_ARGS_LIST
          ? encodeArgsList(input, ctx)
          : encodeAddressList(input, ctx),
    };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

/**
 * Execute uniform mode: all calls on a single network
 */
async function executeUniformMode(
  input: BatchReadContractInput,
  userId: string | undefined
): Promise<BatchReadContractResult> {
  const { network, abi } = input;

  if (!network) {
    return {
      success: false,
      error: "Network is required. Pick one in Network.",
    };
  }

  let callsFrom: CallsFrom;
  try {
    callsFrom = resolveCallsFrom(input.callsFrom);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  if (!abi) {
    const fetchFrom =
      callsFrom === CALLS_FROM_ADDRESS_LIST
        ? "Enter an address in Fetch ABI From to fetch it"
        : "Enter Contract Address to fetch it";
    return {
      success: false,
      error: `Contract ABI is required. ${fetchFrom}, or tick Use manual ABI and paste it.`,
    };
  }

  const encodeResult =
    callsFrom === CALLS_FROM_ARGS_LIST || callsFrom === CALLS_FROM_ADDRESS_LIST
      ? prepareListCalls(input, abi, callsFrom)
      : prepareRowCalls(input, abi);
  if (encodeResult.error !== undefined) {
    logValidationError(encodeResult.error);
    return { success: false, error: encodeResult.error };
  }

  const chainRpc = await resolveChainRpc(network, userId);
  if (chainRpc.error !== undefined) {
    return { success: false, destinationError: true, error: chainRpc.error };
  }

  const { results, error: batchError } = await executeMulticallBatches(
    encodeResult.encoded,
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
  const { calls: normalizedCalls, error: callsError } = buildMixedCalls(
    input.calls
  );

  if (callsError) {
    logValidationError(callsError);
    return { success: false, error: callsError };
  }

  if (normalizedCalls.length === 0) {
    return { success: false, error: "No calls to execute" };
  }

  if (normalizedCalls.length > MAX_TOTAL_CALLS) {
    return {
      success: false,
      error: `Too many calls (${normalizedCalls.length}). Maximum is ${MAX_TOTAL_CALLS}.`,
    };
  }

  const encodeResult = encodeMixedCalls(normalizedCalls);
  if (encodeResult.error) {
    logValidationError(encodeResult.error);
    return { success: false, error: encodeResult.error };
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
  const isUniform = input.inputMode !== "mixed";

  if (isUniform) {
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
