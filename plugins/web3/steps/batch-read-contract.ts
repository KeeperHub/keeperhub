import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

const LOG_PREFIX = "[Batch Read Contract]";
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_TOTAL_CALLS = 5000;

/**
 * Get userId from executionId by querying the workflowExecutions table
 */
async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.userId;
}

type CallResult = {
  success: boolean;
  result: unknown;
  error?: string;
};

type BatchReadContractResult =
  | { success: true; results: CallResult[]; totalCalls: number }
  | { success: false; error: string };

export type BatchReadContractCoreInput = {
  network?: string;
  abi?: string;
  inputMode?: string;
  contractAddress?: string;
  abiFunction?: string;
  argsList?: string;
  calls?: string;
  batchSize?: string;
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
    return { calls: [], error: "Contract Address is required in uniform mode" };
  }

  if (!ethers.isAddress(contractAddress)) {
    return {
      calls: [],
      error: `Invalid contract address: ${contractAddress}`,
    };
  }

  if (!abiFunction) {
    return { calls: [], error: "Function is required in uniform mode" };
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
    return { error: `Call at index ${index} must be an object` };
  }

  const typedCall = call as Record<string, unknown>;
  const addr = typedCall.contractAddress;
  const fn = typedCall.abiFunction;
  const args = typedCall.args;
  const abi = typedCall.abi;
  const callNetwork = typedCall.network;

  if (typeof callNetwork !== "string" || !callNetwork) {
    return { error: `Call at index ${index} missing network` };
  }

  if (typeof addr !== "string" || !addr) {
    return { error: `Call at index ${index} missing contractAddress` };
  }

  if (!ethers.isAddress(addr)) {
    return { error: `Call at index ${index} has invalid address: ${addr}` };
  }

  if (typeof fn !== "string" || !fn) {
    return { error: `Call at index ${index} missing abiFunction` };
  }

  if (typeof abi !== "string" || !abi) {
    return { error: `Call at index ${index} missing abi` };
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
      error: `Failed to parse ABI: ${getErrorMessage(error)}`,
    };
  }

  const functionAbis = new Map<
    string,
    { outputs?: { name?: string; type?: string }[] }
  >();
  for (const item of parsedAbi) {
    const abiItem = item as {
      type?: string;
      name?: string;
      outputs?: { name?: string; type?: string }[];
    };
    if (abiItem.type === "function" && abiItem.name) {
      functionAbis.set(abiItem.name, { outputs: abiItem.outputs });
    }
  }

  const encoded: EncodedCallWithMeta[] = [];
  for (const [index, call] of normalizedCalls.entries()) {
    if (!functionAbis.has(call.abiFunction)) {
      return {
        encoded: [],
        error: `Function '${call.abiFunction}' not found in ABI (call index ${index})`,
      };
    }

    try {
      const callData = iface.encodeFunctionData(call.abiFunction, call.args);
      encoded.push({
        target: call.contractAddress,
        allowFailure: true,
        callData,
        abiFunction: call.abiFunction,
        iface,
        functionAbi: functionAbis.get(call.abiFunction),
      });
    } catch (error) {
      return {
        encoded: [],
        error: `Failed to encode call at index ${index} (${call.abiFunction}): ${getErrorMessage(error)}`,
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
        error: `Call at index ${index} missing ABI`,
      };
    }

    const { parsed: callAbi, error: abiError } = parseAbi(call.abi);
    if (abiError) {
      return {
        encoded: [],
        error: `Call at index ${index}: ${abiError}`,
      };
    }

    let iface: ethers.Interface;
    try {
      iface = new ethers.Interface(callAbi);
    } catch (error) {
      return {
        encoded: [],
        error: `Call at index ${index}: Failed to parse ABI: ${getErrorMessage(error)}`,
      };
    }

    // Find the function in this call's ABI
    const functionAbiItem = callAbi.find(
      (item) =>
        (item as { type?: string }).type === "function" &&
        item.name === call.abiFunction
    ) as { outputs?: { name?: string; type?: string }[] } | undefined;

    if (!functionAbiItem) {
      return {
        encoded: [],
        error: `Call at index ${index}: Function '${call.abiFunction}' not found in ABI`,
      };
    }

    try {
      const callData = iface.encodeFunctionData(call.abiFunction, call.args);
      encoded.push({
        target: call.contractAddress,
        allowFailure: true,
        callData,
        abiFunction: call.abiFunction,
        iface,
        functionAbi: functionAbiItem,
      });
    } catch (error) {
      return {
        encoded: [],
        error: `Failed to encode call at index ${index} (${call.abiFunction}): ${getErrorMessage(error)}`,
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
        revertReason = `Call reverted: ${decoded.name}(${decoded.args.join(", ")})`;
      }
    } catch {
      if (returnData && returnData !== "0x") {
        try {
          const reason = ethers.AbiCoder.defaultAbiCoder().decode(
            ["string"],
            ethers.dataSlice(returnData, 4)
          );
          revertReason = `Call reverted: ${reason[0]}`;
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
      error: `Failed to decode result: ${getErrorMessage(error)}`,
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
      logUserError(
        ErrorCategory.NETWORK_RPC,
        `${LOG_PREFIX} Multicall batch ${batchIndex + 1} failed`,
        error,
        {
          plugin_name: "web3",
          action_name: "batch-read-contract",
          chain_id: String(chainId),
        }
      );
      return {
        results: [],
        error: `Multicall batch ${batchIndex + 1}/${totalBatches} failed: ${getErrorMessage(error)}`,
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

/**
 * Execute uniform mode: all calls on a single network
 */
async function executeUniformMode(
  input: BatchReadContractInput,
  userId: string | undefined
): Promise<BatchReadContractResult> {
  const { network, abi } = input;

  if (!network) {
    return { success: false, error: "Network is required in uniform mode" };
  }

  if (!abi) {
    return { success: false, error: "ABI is required in uniform mode" };
  }

  const { calls: normalizedCalls, error: callsError } = buildUniformCalls(
    input.contractAddress,
    input.abiFunction,
    input.argsList
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

  const { parsed: parsedAbi, error: abiError } = parseAbi(abi);
  if (abiError) {
    logValidationError(abiError);
    return { success: false, error: abiError };
  }

  const encodeResult = encodeUniformCalls(normalizedCalls, parsedAbi);
  if (encodeResult.error) {
    logValidationError(encodeResult.error);
    return { success: false, error: encodeResult.error };
  }

  const chainRpc = await resolveChainRpc(network, userId);
  if (chainRpc.error !== undefined) {
    return { success: false, error: chainRpc.error };
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
  type GroupFailure = { ok: false; error: string };
  type GroupOutcome = GroupSuccess | GroupFailure;

  // Execute all network groups in parallel
  const allResults: CallResult[] = new Array(normalizedCalls.length);
  const groupEntries = [...networkGroups.entries()];

  const groupOutcomes: GroupOutcome[] = await Promise.all(
    groupEntries.map(async ([networkKey, group]): Promise<GroupOutcome> => {
      const chainRpc = await resolveChainRpc(networkKey, userId);
      if (chainRpc.error !== undefined) {
        return { ok: false, error: chainRpc.error };
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
      return { success: false, error: outcome.error };
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
  const userId = await getUserIdFromExecution(input._context?.executionId);
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

  return await withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "batch-read-contract",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

batchReadContractStep.maxRetries = 0;

export const _integrationType = "web3";
