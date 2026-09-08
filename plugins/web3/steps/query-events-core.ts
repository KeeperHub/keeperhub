import { sleep } from "@/lib/sleep";
import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";

export type AbiEntry = { type: string; name: string };

export type BatchQueryResult = {
  events: (ethers.Log | ethers.EventLog)[];
  // The block actually scanned up to. Equal to the requested `end` for a
  // non-tip batch. For the tip batch it is derived from the query result
  // itself (see fetchTipBatch) rather than a separate RPC call, since only
  // the exact call that served the query can vouch for what it covered --
  // the caller's reported `toBlock` must use this, not the originally
  // requested `end`, or it will misstate what was actually queried.
  actualEnd: number;
};

// A single batch can transiently time out on both RPC endpoints during a long
// scan (e.g. 30-60 day event ranges). Rather than failing the whole node (and
// having the durable engine replay the entire multi-minute scan), retry the
// failing batch with a backoff so a blip does not sink the run.
export const MAX_BATCH_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 2000;

// A batch is also at risk of the cross-replica race described below even if
// it isn't the literal final batch of a "latest"-resolved range: when the
// range length leaves a small remainder over the batch size, the batch
// immediately before the tip can end within a handful of blocks of the
// resolved-latest estimate -- close enough for a lagging replica to reject
// it with the same "block range extends beyond current head" error. This
// margin widens tip-batch treatment to any batch ending this close to the
// estimate, not just the one landing exactly on it.
export const TIP_SAFETY_MARGIN_BLOCKS = 5;

// Whether a batch ending at `batchEnd` should be queried as a tip batch
// (against the literal "latest" tag) rather than a fixed numeric end. Only
// relevant for ranges whose end we resolved ourselves (`toBlockIsLatest`) --
// an explicit user-provided toBlock is always a fixed query.
export function isNearHeadBatch(
  batchEnd: number,
  toBlock: number,
  toBlockIsLatest: boolean
): boolean {
  return toBlockIsLatest && toBlock - batchEnd < TIP_SAFETY_MARGIN_BLOCKS;
}

function resolveEventFilter(
  contract: ethers.Contract,
  eventName: string
): ethers.DeferredTopicFilter {
  const eventFilter = contract.filters[eventName]?.();
  if (eventFilter === undefined || eventFilter === null) {
    throw new Error(`Could not create filter for event '${eventName}'`);
  }
  return eventFilter;
}

async function fetchFixedBatch(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  parsedAbi: AbiEntry[],
  eventName: string,
  start: number,
  end: number
): Promise<BatchQueryResult> {
  const contract = new ethers.Contract(contractAddress, parsedAbi, provider);
  const eventFilter = resolveEventFilter(contract, eventName);
  const events = await contract.queryFilter(eventFilter, start, end);
  return { events, actualEnd: end };
}

// The tip batch of a "latest"-resolved range is the only one at risk of
// asking for a block a node hasn't caught up to yet: a load-balanced RPC
// endpoint can route an earlier head-check and this batch's eth_getLogs to
// two different backend replicas that have not converged (a fast replica
// answers the check, a slower one serves the query). Passing the literal
// block tag "latest" to eth_getLogs instead of a previously-resolved number
// eliminates that race entirely -- whichever replica serves this call
// resolves "latest" against its own head, so it can never reject its own
// answer as beyond its own head.
//
// A separate getBlockNumber() call is deliberately NOT used to report
// `actualEnd`: even issued against the same `provider` object, a concurrent
// request isn't guaranteed to land on the same backend replica as the
// queryFilter call, so it could report a head more advanced than what this
// call's replica actually resolved "latest" to -- overstating what was
// scanned and, if a caller checkpoints off `toBlock`, risking a skipped
// range on the next run. The highest event block actually returned is the
// only value this exact call can vouch for.
async function fetchTipBatch(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  parsedAbi: AbiEntry[],
  eventName: string,
  start: number
): Promise<BatchQueryResult> {
  const contract = new ethers.Contract(contractAddress, parsedAbi, provider);
  const eventFilter = resolveEventFilter(contract, eventName);
  const events = await contract.queryFilter(eventFilter, start, "latest");

  const actualEnd = events.reduce(
    (max, event) => Math.max(max, event.blockNumber),
    start - 1
  );

  return { events, actualEnd };
}

// Query a single block range, failing over between RPC endpoints AND retrying
// the batch with a backoff (at least MAX_BATCH_RETRIES attempts) before giving
// up. A timed-out batch is the common transient failure on long scans; this
// keeps it from sinking the whole node.
//
// `isTipBatch` marks the final batch of a range whose end we resolved
// ourselves (see query-events.ts's `toBlockIsLatest`). Only that batch
// queries against "latest" directly; an explicit user-provided toBlock is
// always queried as a fixed number, so a real user misconfiguration still
// surfaces as an error instead of being silently reinterpreted.
export async function queryBatchWithRetry(
  rpcManager: RpcProviderManager,
  contractAddress: string,
  parsedAbi: AbiEntry[],
  eventName: string,
  start: number,
  end: number,
  isTipBatch: boolean
): Promise<BatchQueryResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
    try {
      return await rpcManager.executeWithFailover((provider) =>
        isTipBatch
          ? fetchTipBatch(provider, contractAddress, parsedAbi, eventName, start)
          : fetchFixedBatch(
              provider,
              contractAddress,
              parsedAbi,
              eventName,
              start,
              end
            )
      );
    } catch (error) {
      lastError = error;
      console.log(
        `[Query Events] Batch ${start}-${end} failed (attempt ${attempt}/${MAX_BATCH_RETRIES}): ${getErrorMessage(error)}`
      );
      if (attempt < MAX_BATCH_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}
