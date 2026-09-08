import "server-only";

import { ethers } from "ethers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { evmOnlyGuard } from "@/lib/web3/validate-chain-address";
import {
  type BlockRange,
  resolveBlockRange,
} from "./block-range-helpers";
import {
  type AbiEntry,
  isNearHeadBatch,
  queryBatchWithRetry,
} from "./query-events-core";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";

const DEFAULT_BATCH_SIZE = 2000;

type DecodedEvent = {
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  args: Record<string, unknown>;
};

type QueryEventsResult =
  | {
      success: true;
      // Null when failOnError=false softened a failed query into a success
      // value so the workflow continues; `error` carries the reason. Null
      // rather than an empty list so a downstream node cannot read a failed
      // query as "no events in range".
      events: DecodedEvent[] | null;
      fromBlock: number | null;
      toBlock: number | null;
      eventCount: number | null;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

/** Data fields a softened query reports, so a soft failure never looks like an empty result set. */
const SOFT_QUERY_FIELDS = {
  events: null,
  fromBlock: null,
  toBlock: null,
  eventCount: null,
} as const;

export type QueryEventsCoreInput = ReadFailOnErrorInput & {
  network: string;
  contractAddress: string;
  abi: string;
  eventName: string;
  fromBlock?: string;
  toBlock?: string;
  blockCount?: number | string;
};

export type QueryEventsInput = StepInput & QueryEventsCoreInput;

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

  // Resolve the chain first so the address check and the Solana guard below
  // can branch on the chain family.
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  // Event querying decodes EVM ABI logs, which have no Solana equivalent
  // (Solana program logs are untyped and unindexed) - not yet supported.
  const evmOnlyResult = evmOnlyGuard(chainId);
  if (evmOnlyResult) {
    return evmOnlyResult;
  }

  if (!ethers.isAddress(contractAddress)) {
    return {
      success: false,
      destinationError: true,
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

  const userId = await getRpcPreferenceUserId(_context?.executionId);

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
      destinationError: true,
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
  if (range.toBlockIsLatest) {
    console.log("[Query Events] Resolved latest block:", range.toBlock);
  }

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
    const message = `Event query failed: ${getErrorMessage(error)}`;
    return { success: false, error: message };
  }
}

export async function queryEventsStep(
  input: QueryEventsInput
): Promise<QueryEventsResult> {
  "use step";

  const contractAddressLink = await resolveExplorerLink(
    input.network,
    input.contractAddress
  );
  const enrichedInput: QueryEventsInput & { contractAddressLink?: string } =
    contractAddressLink ? { ...input, contractAddressLink } : input;

  return runPluginStep(
    { pluginName: "web3", actionName: "query-events" },
    enrichedInput,
    async () =>
      applyReadFailOnError(
        await stepHandler(input),
        input.failOnError,
        SOFT_QUERY_FIELDS
      )
  );
}

queryEventsStep.maxRetries = 0;

export const _integrationType = "web3";
