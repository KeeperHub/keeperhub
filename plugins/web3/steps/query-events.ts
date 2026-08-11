import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import {
  type AbiEntry,
  isNearHeadBatch,
  queryBatchWithRetry,
} from "./query-events-core";

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_BLOCK_LOOKBACK = 6500;

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

type DecodedEvent = {
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  args: Record<string, unknown>;
};

type QueryEventsResult =
  | {
      success: true;
      events: DecodedEvent[];
      fromBlock: number;
      toBlock: number;
      eventCount: number;
    }
  | { success: false; error: string };

export type QueryEventsCoreInput = {
  network: string;
  contractAddress: string;
  abi: string;
  eventName: string;
  fromBlock?: string;
  toBlock?: string;
  blockCount?: number | string;
};

export type QueryEventsInput = StepInput & QueryEventsCoreInput;

// `toBlockIsLatest` marks a range whose end was resolved by us (from an empty
// or "latest" input) rather than given explicitly by the user. Only that case
// is safe to re-verify/clamp against a fresher head at query time -- an
// explicit user-provided toBlock must surface a real error if it turns out to
// be beyond the chain, not get silently truncated.
type BlockRange = { fromBlock: number; toBlock: number; toBlockIsLatest: boolean };

function serializeBigInts(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

function decodeEventArgs(
  event: ethers.EventLog,
  eventFragment: ethers.EventFragment
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [index, input] of eventFragment.inputs.entries()) {
    const name = input.name || `arg${index}`;
    args[name] = serializeBigInts(event.args[index]);
  }
  return args;
}


function parseAbi(
  abi: string
): { success: true; parsed: AbiEntry[] } | { success: false; error: string } {
  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch (error) {
    return {
      success: false,
      error: `Invalid ABI JSON: ${getErrorMessage(error)}`,
    };
  }

  if (!Array.isArray(parsedAbi)) {
    return { success: false, error: "ABI must be a JSON array" };
  }

  return { success: true, parsed: parsedAbi as AbiEntry[] };
}

function parseBlockCount(
  blockCountInput: number | string | undefined
): { success: true; value: number } | { success: false; error: string } | null {
  if (blockCountInput === undefined || blockCountInput === null) {
    return null;
  }

  const strVal =
    typeof blockCountInput === "string" ? blockCountInput.trim() : "";
  if (typeof blockCountInput === "string" && strVal === "") {
    return null;
  }

  const parsed =
    typeof blockCountInput === "number"
      ? blockCountInput
      : Number.parseInt(strVal, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return {
      success: false,
      error: `Invalid blockCount value: ${blockCountInput}`,
    };
  }

  return { success: true, value: parsed };
}

function resolveFromBlock(
  fromBlockInput: string | undefined,
  blockCountInput: number | string | undefined,
  resolvedToBlock: number
): { success: true; value: number } | { success: false; error: string } {
  const fromBlockStr = fromBlockInput?.toString().trim() ?? "";

  if (fromBlockStr !== "") {
    const parsed = Number.parseInt(fromBlockStr, 10);
    if (Number.isNaN(parsed)) {
      return {
        success: false,
        error: `Invalid fromBlock value: ${fromBlockInput}`,
      };
    }
    return { success: true, value: parsed };
  }

  const blockCountResult = parseBlockCount(blockCountInput);
  if (blockCountResult !== null && !blockCountResult.success) {
    return { success: false, error: blockCountResult.error };
  }

  const lookback =
    blockCountResult !== null ? blockCountResult.value : DEFAULT_BLOCK_LOOKBACK;

  return { success: true, value: Math.max(0, resolvedToBlock - lookback) };
}

async function resolveBlockRange(
  provider: ethers.JsonRpcProvider,
  fromBlockInput: string | undefined,
  toBlockInput: string | undefined,
  blockCountInput: number | string | undefined
): Promise<
  { success: true; range: BlockRange } | { success: false; error: string }
> {
  const toBlockStr = toBlockInput?.toString().trim() ?? "";
  let resolvedToBlock: number;
  const toBlockIsLatest =
    toBlockStr === "" || toBlockStr.toLowerCase() === "latest";

  if (toBlockIsLatest) {
    // This is a planning estimate only -- how many batches to run and where
    // `fromBlock` starts. It is NOT the authoritative bound used for the
    // final eth_getLogs call; see queryBatchWithRetry's tip-batch handling.
    resolvedToBlock = await provider.getBlockNumber();
    console.log("[Query Events] Resolved latest block:", resolvedToBlock);
  } else {
    resolvedToBlock = Number.parseInt(toBlockStr, 10);
    if (Number.isNaN(resolvedToBlock)) {
      return {
        success: false,
        error: `Invalid toBlock value: ${toBlockInput}`,
      };
    }
  }

  const fromBlockResult = resolveFromBlock(
    fromBlockInput,
    blockCountInput,
    resolvedToBlock
  );
  if (!fromBlockResult.success) {
    return { success: false, error: fromBlockResult.error };
  }

  return {
    success: true,
    range: {
      fromBlock: fromBlockResult.value,
      toBlock: resolvedToBlock,
      toBlockIsLatest,
    },
  };
}

type EventBatchesResult = { events: DecodedEvent[]; actualToBlock: number };

async function queryEventBatches(
  rpcManager: RpcProviderManager,
  contractAddress: string,
  parsedAbi: AbiEntry[],
  eventName: string,
  eventFragment: ethers.EventFragment,
  range: BlockRange
): Promise<EventBatchesResult> {
  const batchSize = DEFAULT_BATCH_SIZE;
  const allEvents: DecodedEvent[] = [];
  let actualToBlock = range.fromBlock - 1;

  for (
    let start = range.fromBlock;
    start <= range.toBlock;
    start += batchSize
  ) {
    const end = Math.min(start + batchSize - 1, range.toBlock);
    const isTipBatch = isNearHeadBatch(end, range.toBlock, range.toBlockIsLatest);
    console.log(`[Query Events] Querying batch: blocks ${start} to ${end}`);

    const { events: batchEvents, actualEnd } = await queryBatchWithRetry(
      rpcManager,
      contractAddress,
      parsedAbi,
      eventName,
      start,
      end,
      isTipBatch
    );

    for (const event of batchEvents) {
      if (event instanceof ethers.EventLog) {
        allEvents.push({
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          logIndex: event.index,
          args: decodeEventArgs(event, eventFragment),
        });
      }
    }

    actualToBlock = actualEnd;

    // A tip batch already queried through to the real head via "latest" --
    // there is no fixed-range batch left to run after it.
    if (isTipBatch) {
      break;
    }
    // The batch could not vouch for scanning all the way to its planned end
    // -- later batches would target blocks even further out, so there is
    // nothing left to gain by continuing.
    if (actualEnd < end) {
      break;
    }
  }

  return { events: allEvents, actualToBlock };
}

async function stepHandler(
  input: QueryEventsInput
): Promise<QueryEventsResult> {
  console.log("[Query Events] Starting step with input:", {
    contractAddress: input.contractAddress,
    network: input.network,
    eventName: input.eventName,
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    blockCount: input.blockCount,
    executionId: input._context?.executionId,
  });

  const { contractAddress, network, abi, eventName, _context } = input;

  if (!ethers.isAddress(contractAddress)) {
    return {
      success: false,
      error: `Invalid contract address: ${contractAddress}`,
    };
  }

  const abiResult = parseAbi(abi);
  if (!abiResult.success) {
    return { success: false, error: abiResult.error };
  }

  const eventAbiEntry = abiResult.parsed.find(
    (item) => item.type === "event" && item.name === eventName
  );
  if (!eventAbiEntry) {
    return { success: false, error: `Event '${eventName}' not found in ABI` };
  }

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  const userId = await getUserIdFromExecution(_context?.executionId);

  // Validate event exists in ABI using ethers Interface (no provider needed)
  const iface = new ethers.Interface(abiResult.parsed);
  const eventFragment = iface.getEvent(eventName);
  if (!eventFragment) {
    return {
      success: false,
      error: `Event '${eventName}' not found in contract interface`,
    };
  }

  let rpcManager: RpcProviderManager;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  // Resolve block range (uses RPC for latest block number)
  const blockRangeResult = await rpcManager.executeWithFailover(
    async (provider) =>
      resolveBlockRange(
        provider,
        input.fromBlock,
        input.toBlock,
        input.blockCount
      )
  );
  if (!blockRangeResult.success) {
    return { success: false, error: blockRangeResult.error };
  }
  const { range } = blockRangeResult;

  if (range.fromBlock > range.toBlock) {
    return {
      success: true,
      events: [],
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      eventCount: 0,
    };
  }

  // Query events (each batch fails over between endpoints and retries with a
  // backoff, so a transient timeout on one batch does not fail the whole node).
  try {
    const { events, actualToBlock } = await queryEventBatches(
      rpcManager,
      contractAddress,
      abiResult.parsed,
      eventName,
      eventFragment,
      range
    );

    console.log("[Query Events] Query complete. Events found:", events.length);

    return {
      success: true as const,
      events,
      fromBlock: range.fromBlock,
      toBlock: actualToBlock,
      eventCount: events.length,
    };
  } catch (error) {
    return {
      success: false,
      error: `Event query failed: ${getErrorMessage(error)}`,
    };
  }
}

export async function queryEventsStep(
  input: QueryEventsInput
): Promise<QueryEventsResult> {
  "use step";

  let enrichedInput: QueryEventsInput & { contractAddressLink?: string } =
    input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const contractAddressLink = getAddressUrl(
        explorerConfig,
        input.contractAddress
      );
      if (contractAddressLink) {
        enrichedInput = { ...input, contractAddressLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "query-events",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(enrichedInput, () => stepHandler(input))
  );
}

queryEventsStep.maxRetries = 0;

export const _integrationType = "web3";
