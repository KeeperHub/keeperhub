/**
 * Core batch-write-contract logic. No "use step" directive: this file exists
 * so the step file can reuse validation/encoding/decoding logic without
 * exporting helpers from a "use step" file (which breaks the workflow
 * bundler, see plugins/CLAUDE.md).
 *
 * Sends N state-changing calls to potentially different contracts, each with
 * its own ABI and function, as one atomic transaction via the
 * already-deployed Multicall3 contract's aggregate3(Call3[]) function.
 * Unlike batch-read-contract.ts, which calls aggregate3 via .staticCall for
 * a free read, this broadcasts aggregate3 as a real signed transaction,
 * confirmed payable (not view) in lib/contracts/abis/multicall3.json.
 */
import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { validateArgsForAbi } from "@/lib/abi/validate-args";
import { findAbiFunction } from "@/lib/abi/utils";
import { getAbiFunctionKey } from "@/lib/abi/function-key";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import { getErrorMessage, resolveFailOnError } from "@/lib/utils";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/web3/wallet-helpers";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { rpcRelayErrorClass } from "@/lib/rpc/providers";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import {
  preflightGasBalance,
  resolveFundingHolder,
} from "@/lib/web3/gas-preflight";
import {
  classifyRevert,
  decodeRevertReason,
  formatContractError,
  type RevertKind,
} from "@/lib/web3/decode-revert-error";
import {
  parsePriorityFeeGwei,
  resolveGasLimitOverrides,
} from "@/lib/web3/gas-defaults";
import {
  broadcastTransactionHash,
  isOnChainPendingError,
  isOnChainRevertError,
} from "@/lib/web3/onchain-revert";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import type { TransactionContext } from "@/lib/web3/transaction-manager";
import { withNonceSession } from "@/lib/web3/transaction-manager";
import { generateId } from "@/lib/utils/id";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

// Write batches are gas-bound, not RPC-payload-bound (unlike batch-read's
// 5000-call ceiling). A much lower cap here avoids wasting validation work
// on batches that could never fit inside a block.
const MAX_TOTAL_CALLS = 200;

export type BatchWriteCallResult = {
  success: boolean;
  result?: unknown;
  error?: string;
};

export type BatchWriteContractCoreInput = {
  network: string;
  // JSON string [{ contractAddress, abi, abiFunction, args? }, ...] from the
  // call-list-builder UI field, or a native array from a direct/MCP caller.
  // Each call carries its own contract, ABI, and function; nothing here is
  // shared across calls except `network` (a batch is inherently single-chain
  // since one signed tx can't span chains).
  calls: string | unknown[];
  // "true" (default) or "false" from the workflow UI's string-valued config,
  // but a direct/MCP caller can send a native JSON boolean instead.
  isolateCallFailures?: string | boolean;
  gasLimitMultiplier?: string;
  priorityFeeGwei?: string;
  usePrivateMempool?: boolean;
  strict?: boolean;
  web3Connection?: string;
  _context?: {
    executionId?: string;
    organizationId?: string;
    // Populated directly by the workflow executor's StepContext on every
    // real workflow execution (see executor.workflow.ts). When present,
    // skip the DB lookup below entirely; it exists only as a fallback for
    // callers that supply executionId without it.
    workflowId?: string;
  };
};

export type BatchWriteContractResult =
  | {
    success: true;
    transactionHash?: string;
    chainId?: number;
    transactionLink?: string;
    gasUsed?: string;
    gasUsedUnits?: string;
    effectiveGasPrice?: string;
    results?: BatchWriteCallResult[];
    totalCalls?: number;
    // Present only when failOnError=false softened an execution failure
    // into success (see applyBatchFailOnError). Absent on a genuine
    // successful broadcast.
    error?: string;
    rejection?: RevertKind;
  }
  | {
    success: false;
    error: string;
    rejection?: RevertKind;
    errorClass?: ExecutionErrorType;
    transactionHash?: string;
    chainId?: number;
    // Present when the pre-broadcast simulation ran and decoded per-call
    // outcomes before this failure was returned (e.g. every call failed
    // simulation, so the broadcast was skipped). Absent on failures that
    // occur before or without a simulation (validation, RPC/signer
    // resolution, a whole-batch revert on the staticCall itself).
    results?: BatchWriteCallResult[];
    totalCalls?: number;
  };

/**
 * Soften an execution failure into a success value when failOnError=false, so
 * the workflow continues past a signer/RPC failure or a whole-batch revert
 * instead of aborting. This is a local copy of applyFailOnError in
 * write-contract-core.ts (same rationale and same errorClass carve-out: a
 * failure with no errorClass, meaning the actual attempt to broadcast, or one
 * classified EXTERNAL (an RPC/relay transport failure, see
 * rpcRelayErrorClass) is eligible; USER/SYSTEM configuration failures always
 * hard-fail). Duplicated rather than imported because write-contract-core.ts's
 * version is nominally typed against WriteContractResult, which would drop
 * `results`/`totalCalls` from the return type if reused here.
 */
export function applyBatchFailOnError(
  result: BatchWriteContractResult,
  failOnError: unknown
): BatchWriteContractResult {
  if (result.success || resolveFailOnError(failOnError)) {
    return result;
  }
  if (result.errorClass && result.errorClass !== ExecutionErrorType.EXTERNAL) {
    return result;
  }
  return {
    success: true,
    error: redactAllUrls(result.error),
    rejection: result.rejection,
    // Carried forward when present (e.g. an all-calls-failed simulation
    // abort): unlike transactionHash, these are pre-broadcast diagnostics
    // with no KEEP-966 reconciliation risk, so there is no reason to drop
    // them on a softened result.
    results: result.results,
    totalCalls: result.totalCalls,
  };
}

/** Recursively convert BigInt values to strings without a JSON round-trip. */
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

export type Call3 = { target: string; allowFailure: boolean; callData: string };

/**
 * A single Call3 entry plus the per-call metadata needed to decode its
 * aggregate3 result: the interface/function/outputs that produced its
 * callData. Every call carries its own triple since each can target a
 * different contract, ABI, and function.
 */
export type CallWithMeta = Call3 & {
  iface: ethers.Interface;
  functionKey: string;
  outputs: AbiOutputParam[];
};

/**
 * Best-effort ethers.Interface for decoding a whole-batch revert (the
 * aggregate3 call itself reverting, e.g. one sub-call failed with
 * allowFailure=false). Merges every call's fragments (deduped by signature)
 * so a custom error from any call in the batch has a chance to decode,
 * falling back to the first call's interface if merging ever throws (e.g. an
 * incompatible duplicate signature across two calls' ABIs).
 */
function buildRevertDecodeInterface(
  callsWithMeta: CallWithMeta[]
): ethers.Interface | undefined {
  const first = callsWithMeta[0];
  if (!first) {
    return;
  }
  if (callsWithMeta.length === 1) {
    return first.iface;
  }
  const seen = new Set<string>();
  const fragments: ethers.Fragment[] = [];
  for (const call of callsWithMeta) {
    for (const fragment of call.iface.fragments) {
      const key = fragment.format();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      fragments.push(fragment);
    }
  }
  try {
    return new ethers.Interface(fragments);
  } catch {
    return first.iface;
  }
}

/** Decode a single aggregate3 Result entry against its own call's function. */
function decodeAggregate3Entry(
  callSuccess: boolean,
  returnData: string,
  iface: ethers.Interface,
  functionKey: string,
  outputs: AbiOutputParam[]
): BatchWriteCallResult {
  if (!callSuccess) {
    // decodeRevertReason expects an ethers-error-shaped object; { data }
    // is enough for extractRevertData to find it. Reuses the same
    // own-ABI -> common-OZ-selector -> string-revert fallback chain the
    // whole-batch-revert path already gets via formatContractError, so a
    // custom error not declared in this call's own ABI (e.g. an inherited
    // OwnableUnauthorizedAccount) still decodes here instead of falling
    // back to a bare "Call reverted".
    const decoded = decodeRevertReason({ data: returnData }, iface);
    const revertReason = decoded ? `Call reverted: ${decoded}` : "Call reverted";
    return { success: false, result: undefined, error: revertReason };
  }

  try {
    const decoded = iface.decodeFunctionResult(functionKey, returnData);
    const serialized = serializeBigInts(decoded);
    const structured =
      outputs.length > 0
        ? structureAbiOutputs(
          Array.isArray(serialized) ? serialized : [serialized],
          outputs
        )
        : serialized;
    return { success: true, result: structured };
  } catch (error) {
    return {
      success: false,
      result: undefined,
      error: `Failed to decode result: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Reshape, coerce, and validate one call's args against its function ABI.
 */
function coerceAndValidateArgs(
  rawArgs: unknown,
  index: number,
  // biome-ignore lint/suspicious/noExplicitAny: ethers ABI fragment shape, mirrors write-contract-core's functionAbi typing
  functionAbi: any
): { args: unknown[]; error?: string } {
  if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
    return { args: [], error: `Call at index ${index}: args must be an array` };
  }
  let args: unknown[] = Array.isArray(rawArgs) ? rawArgs : [];
  try {
    args = reshapeArgsForAbi(args, functionAbi);
    args = coerceArgsForAbi(args, functionAbi);
    const validation = validateArgsForAbi(args, functionAbi);
    if (!validation.ok) {
      return { args: [], error: `Call at index ${index}: ${validation.error}` };
    }
  } catch (error) {
    return { args: [], error: `Call at index ${index}: ${getErrorMessage(error)}` };
  }
  return { args };
}

/**
 * Derive Call3.allowFailure from the isolateCallFailures config, defaulting
 * to true (isolated) when absent. Mirrors resolveFailOnError's own
 * true-boolean-or-string-false guard (lib/utils.ts): the workflow UI always
 * sends a string, but a direct/MCP caller can send a native JSON boolean, and
 * `!== "false"` alone would treat boolean false the same as true, the
 * opposite of what the caller asked for.
 */
function resolveIsolateCallFailures(
  isolateCallFailures: string | boolean | undefined
): boolean {
  return isolateCallFailures !== false && isolateCallFailures !== "false";
}

type RawCallEntry = {
  contractAddress: string;
  abi: string;
  abiFunction: string;
  args: unknown;
};

type CallEntryResult =
  | { ok: true; call: RawCallEntry }
  | { ok: false; error: string };

/** Validate one call entry's shape (not its args, done later once the entry's own function ABI is resolved). */
function validateCallEntry(entry: unknown, index: number): CallEntryResult {
  if (typeof entry !== "object" || entry === null) {
    return { ok: false, error: `Call at index ${index} must be an object` };
  }
  const typedEntry = entry as Record<string, unknown>;

  const contractAddress = typedEntry.contractAddress;
  if (typeof contractAddress !== "string" || !contractAddress) {
    return { ok: false, error: `Call at index ${index} missing contractAddress` };
  }
  if (!ethers.isAddress(contractAddress)) {
    return {
      ok: false,
      error: `Call at index ${index} has invalid address: ${contractAddress}`,
    };
  }

  const abi = typedEntry.abi;
  if (typeof abi !== "string" || !abi) {
    return { ok: false, error: `Call at index ${index} missing abi` };
  }

  const abiFunction = typedEntry.abiFunction;
  if (typeof abiFunction !== "string" || !abiFunction) {
    return { ok: false, error: `Call at index ${index} missing abiFunction` };
  }

  return {
    ok: true,
    call: { contractAddress, abi, abiFunction, args: typedEntry.args },
  };
}

type CallWithMetaResult =
  | { ok: true; call: CallWithMeta }
  | { ok: false; error: string };

/** Parse, validate, and encode one call entry against its own ABI. */
function buildCallWithMeta(
  entry: unknown,
  index: number,
  allowFailure: boolean
): CallWithMetaResult {
  const entryResult = validateCallEntry(entry, index);
  if (!entryResult.ok) {
    return entryResult;
  }
  const rawCall = entryResult.call;

  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(rawCall.abi);
  } catch (error) {
    return {
      ok: false,
      error: `Call at index ${index}: Invalid ABI JSON: ${getErrorMessage(error)}`,
    };
  }
  if (!Array.isArray(parsedAbi)) {
    return { ok: false, error: `Call at index ${index}: ABI must be a JSON array` };
  }

  const functionAbi = findAbiFunction(parsedAbi, rawCall.abiFunction);
  if (!functionAbi) {
    return {
      ok: false,
      error: `Call at index ${index}: Function '${rawCall.abiFunction}' not found in ABI`,
    };
  }
  const functionKey = getAbiFunctionKey(parsedAbi, rawCall.abiFunction, functionAbi);

  const { args, error: argsError } = coerceAndValidateArgs(
    rawCall.args,
    index,
    functionAbi
  );
  if (argsError) {
    return { ok: false, error: argsError };
  }

  let iface: ethers.Interface;
  let callData: string;
  try {
    iface = new ethers.Interface(parsedAbi as ethers.InterfaceAbi);
    callData = iface.encodeFunctionData(functionKey, args);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to encode call at index ${index}: ${getErrorMessage(error)}`,
    };
  }

  const outputs = (functionAbi as { outputs?: AbiOutputParam[] }).outputs ?? [];
  return {
    ok: true,
    call: {
      target: rawCall.contractAddress,
      allowFailure,
      callData,
      iface,
      functionKey,
      outputs,
    },
  };
}

/**
 * Build this batch's CallWithMeta[]: each entry in `calls` is parsed,
 * coerced, and encoded independently against its own contract/ABI/function.
 * Fails fast on the first invalid entry. Exported so
 * app/api/gas/estimate/route.ts builds the exact same calls this step would
 * broadcast, instead of duplicating the parse/encode logic.
 */
export function buildCallsWithMeta(input: {
  calls: string | unknown[];
  isolateCallFailures?: string | boolean;
}): { calls: CallWithMeta[]; error?: string } {
  let parsed: unknown = input.calls;
  if (typeof input.calls === "string") {
    try {
      parsed = JSON.parse(input.calls);
    } catch (error) {
      return { calls: [], error: `Invalid Calls JSON: ${getErrorMessage(error)}` };
    }
  }

  if (!Array.isArray(parsed)) {
    return { calls: [], error: "Calls must be a JSON array" };
  }
  if (parsed.length === 0) {
    return { calls: [], error: "Calls must contain at least one entry" };
  }
  if (parsed.length > MAX_TOTAL_CALLS) {
    return {
      calls: [],
      error: `Too many calls (${parsed.length}). Maximum is ${MAX_TOTAL_CALLS}.`,
    };
  }

  const allowFailure = resolveIsolateCallFailures(input.isolateCallFailures);
  const calls: CallWithMeta[] = [];
  for (const [index, entry] of parsed.entries()) {
    const built = buildCallWithMeta(entry, index, allowFailure);
    if (!built.ok) {
      return { calls: [], error: built.error };
    }
    calls.push(built.call);
  }
  return { calls };
}

async function getWorkflowIdFromExecution(
  executionId: string | undefined,
  organizationId: string | undefined
): Promise<string | undefined> {
  // A direct execution (app/api/execute/node/route.ts) sets both
  // executionId and organizationId, but its executionId is not a
  // workflowExecutions row, so this lookup can never return anything for
  // that shape. Only attempt it for the case it exists for: an execution
  // supplying executionId without organizationId.
  if (!executionId || organizationId) {
    return;
  }
  try {
    const execution = await db
      .select({ workflowId: workflowExecutions.workflowId })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, executionId))
      .then((rows) => rows[0]);
    return execution?.workflowId ?? undefined;
  } catch {
    // Non-critical: workflowId is optional for tracking
    return;
  }
}

/**
 * Core batch write contract logic. Sends N calls to Multicall3's aggregate3
 * as a single atomic transaction, isolating per-call failures according to
 * `isolateCallFailures`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contract interaction requires extensive validation, mirrors write-contract-core.ts
export async function batchWriteContractCore(
  input: BatchWriteContractCoreInput
): Promise<BatchWriteContractResult> {
  const {
    network,
    calls,
    isolateCallFailures,
    gasLimitMultiplier,
    priorityFeeGwei,
    usePrivateMempool,
    strict,
    web3Connection,
    _context,
  } = input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);
  const priorityFeeOverride = parsePriorityFeeGwei(priorityFeeGwei);

  const { calls: callsWithMeta, error: buildError } = buildCallsWithMeta({
    calls,
    isolateCallFailures,
  });
  if (buildError) {
    return { success: false, error: buildError, errorClass: ExecutionErrorType.USER };
  }

  const call3Array: Call3[] = callsWithMeta.map(
    ({ target, allowFailure, callData }) => ({ target, allowFailure, callData })
  );
  const revertIface = buildRevertDecodeInterface(callsWithMeta);

  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Batch Write Contract]",
    "batch-write-contract"
  );
  if (!orgCtx.success) {
    return { success: false, error: orgCtx.error, errorClass: ExecutionErrorType.SYSTEM };
  }
  const { organizationId, userId } = orgCtx;

  let chainId: number;
  let rpcUrl: string;
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    chainId = getChainIdFromNetwork(network);
    rpcManager = await getRpcProvider({ chainId, userId, usePrivateMempool, strict });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }

  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }

  let signerMode: Awaited<ReturnType<typeof resolveSignerForNode>>;
  try {
    signerMode = await resolveSignerForNode({ organizationId, chainId, web3Connection });
  } catch (error) {
    return {
      success: false,
      error: `Failed to resolve Web3 Connection: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }
  if (signerMode.kind !== SIGNER_MODE.EOA) {
    return {
      success: false,
      error:
        "Batch Write Contract only supports the default EOA Web3 Connection. Safe/Role routing would change msg.sender for every batched call, which is not supported here. Use individual Write Contract nodes for Safe execution instead.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Pre-broadcast simulation: aggregate3 has no equivalent to a transaction
  // receipt's decoded return data, so this is the only way to get per-call
  // success/result/error before, and immediately preceding, the real send.
  let aggregateResults: [boolean, string][];
  try {
    aggregateResults = await rpcManager.executeWithFailover(
      (provider) =>
        new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider)
          .aggregate3.staticCall(call3Array, {
            from: walletAddress,
          }) as Promise<[boolean, string][]>
    );
  } catch (error) {
    const rejection = classifyRevert(error, revertIface);
    return {
      success: false,
      error: formatContractError(error, revertIface),
      ...(rejection.kind !== "unknown" ? { rejection } : {}),
    };
  }

  if (aggregateResults.length !== callsWithMeta.length) {
    return {
      success: false,
      error: `Simulation returned ${aggregateResults.length} results for ${callsWithMeta.length} calls`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  const results = aggregateResults.map(([ok, data], index) => {
    const meta = callsWithMeta[index];
    return decodeAggregate3Entry(ok, data, meta.iface, meta.functionKey, meta.outputs);
  });

  // Key the abort on the raw on-chain flag, not the decoded `results`
  // success flag. decodeAggregate3Entry also reports success:false when a
  // call succeeded on-chain but its return data doesn't decode against the
  // declared ABI outputs (e.g. a USDT-style transfer() declared as
  // `returns (bool)` against a contract that returns nothing). The raw flag
  // is the only field that reflects what aggregate3 actually did; `results`
  // still carries the decoded per-call detail for the response either way.
  const allReverted =
    aggregateResults.length > 0 && aggregateResults.every(([ok]) => !ok);
  if (allReverted) {
    return {
      success: false,
      error: `All ${results.length} calls failed simulation; skipping broadcast to avoid wasting gas. First error: ${results[0].error}`,
      results,
      totalCalls: results.length,
    };
  }

  // The executor already puts workflowId directly on _context for every real
  // workflow execution, so only fall back to a DB lookup when a caller
  // supplies executionId without it.
  const workflowId =
    _context?.workflowId ??
    (await getWorkflowIdFromExecution(_context?.executionId, _context?.organizationId));

  const txContext: TransactionContext = {
    organizationId,
    executionId: _context?.executionId ?? `direct-${generateId()}`,
    workflowId,
    chainId,
    rpcUrl,
    rpcManager,
  };

  const adapter = getChainAdapter(chainId);

  // Answer affordability before queueing on the wallet's nonce lock. A holder
  // that cannot pay would otherwise take the lock, spend a full failover
  // round discovering that at broadcast, and stall every other execution for
  // the same wallet behind it. Mirrors write-contract-core's own preflight;
  // resolveFundingHolder always resolves to walletAddress here since the EOA
  // gate above already rejects Safe/Safe-Role connections.
  const gasCheck = await preflightGasBalance({
    rpcManager,
    chainId,
    holderAddress: resolveFundingHolder(signerMode, walletAddress),
  });
  if (!gasCheck.affordable) {
    return { success: false, error: gasCheck.message };
  }

  return withNonceSession(txContext, walletAddress, async (session) => {
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    try {
      const receipt = await adapter.executeContractCall(
        signer,
        {
          contractAddress: MULTICALL3_ADDRESS,
          abi: MULTICALL3_ABI,
          functionKey: "aggregate3",
          args: [call3Array],
        },
        session,
        {
          gasOverrides: { multiplierOverride, gasLimitOverride, priorityFeeOverride },
          workflowId,
          rpcManager,
        }
      );

      const gasUsedUnits = receipt.gasUsed.toString();
      const effectiveGasPrice = receipt.effectiveGasPrice.toString();
      const gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);

      return {
        success: true,
        transactionHash: receipt.hash,
        chainId,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
        results,
        totalCalls: results.length,
      };
    } catch (error) {
      const rejection = classifyRevert(error, revertIface);
      // Set so a failOnError=false node cannot soften an unresolved in-flight
      // send into success. A relay-determined class is the more specific
      // answer, so it wins.
      const errorClass =
        rpcRelayErrorClass(error) ??
        (isOnChainPendingError(error) ? ExecutionErrorType.SYSTEM : undefined);
      const broadcastHash = broadcastTransactionHash(error);
      const base = {
        success: false as const,
        error: formatContractError(error, revertIface),
        ...(errorClass ? { errorClass } : {}),
        ...(broadcastHash ? { transactionHash: broadcastHash, chainId } : {}),
        ...(rejection.kind !== "unknown" ? { rejection } : {}),
      };
      // aggregate3 is atomic, so a confirmed on-chain revert (receipt status
      // 0) is the one case where every call's outcome is actually known:
      // none of them took effect. Any other failure (a pre-broadcast
      // rejection, or a post-submission confirmation timeout where the
      // transaction may already be mined) has an unknown per-call outcome,
      // so results/totalCalls are left out rather than guessed here, same as
      // every other write action already does when the true outcome can't
      // be determined.
      if (!isOnChainRevertError(error)) {
        return base;
      }
      const revertedResults: BatchWriteCallResult[] = results.map((r) => ({
        success: false,
        result: undefined,
        error: `Reverted on-chain: ${r.error ?? "the batch transaction was broadcast and mined but reverted"}`,
      }));
      return {
        ...base,
        results: revertedResults,
        totalCalls: revertedResults.length,
      };
    }
  });
}
