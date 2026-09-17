import { sleep } from "@/lib/sleep";
import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import { coerceArgsForAbi } from "@/lib/abi/struct-args";
import type { AbiParam } from "@/lib/abi/types";

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

/**
 * Expand an indexed-only positional arg array (the output of
 * `parseIndexedEventArgs`) to a full positional array over ALL of the
 * event's inputs, interleaving `null` wildcards at non-indexed positions.
 *
 * ethers maps filter args positionally over every event input
 * (`contract.filters[eventName](...args)` and
 * `iface.encodeFilterTopics(fragment, values)` alike): passing the
 * indexed-only array straight through misaligns whenever a non-indexed
 * input precedes an indexed one (e.g. `Mixed(uint256 amount, address
 * indexed who)`), binding the address to the non-indexed slot and making
 * topic encoding throw "cannot filter non-indexed parameters; must be
 * null". Always run the parsed args through this before touching ethers.
 */
export function expandIndexedArgsToEventPositions(
  eventFragment: ethers.EventFragment,
  indexedArgs: (unknown | null)[]
): (unknown | null)[] {
  const indexedCount = eventFragment.inputs.filter(
    (input) => input.indexed
  ).length;
  if (indexedArgs.length > indexedCount) {
    // Defense in depth: the step handler's parseIndexedEventArgs already
    // rejects over-count input before any RPC work, but the batch path
    // must never silently drop a filter value either.
    throw new Error(
      `too many arguments for event '${eventFragment.name}': got ${indexedArgs.length} indexed arg(s), event has only ${indexedCount} indexed input(s)`
    );
  }
  const full: (unknown | null)[] = [];
  let i = 0;
  for (const input of eventFragment.inputs) {
    full.push(input.indexed ? (indexedArgs[i++] ?? null) : null);
  }
  return full;
}

/**
 * Encode the eth_getLogs topics for an event's indexed-argument filters,
 * attributing encoding failures to the offending parameter by name and type.
 *
 * ethers' own errors name neither the parameter nor its position (a mistyped
 * `from` surfaces as `invalid address (argument="address", value="0x...")`),
 * so each non-wildcard value is first probed on its own topic position: the
 * first value that fails to encode throws with the parameter's name and type
 * prefixed. A final full encode then validates the combination.
 */
export function encodeEventFilterTopics(
  iface: ethers.Interface,
  eventFragment: ethers.EventFragment,
  indexedArgs: (unknown | null)[]
): (string | string[] | null)[] {
  const fullArgs = expandIndexedArgsToEventPositions(eventFragment, indexedArgs);
  // Map each indexed input to its position in the full (all-inputs) array.
  const indexedPositions: number[] = [];
  for (const [position, input] of eventFragment.inputs.entries()) {
    if (input.indexed) {
      indexedPositions.push(position);
    }
  }
  for (let i = 0; i < indexedPositions.length; i++) {
    const value = indexedArgs[i];
    if (value === null || value === undefined) {
      continue;
    }
    const position = indexedPositions[i];
    const input = eventFragment.inputs[position];
    const probe = new Array<unknown>(fullArgs.length).fill(null);
    probe[position] = value;
    try {
      iface.encodeFilterTopics(eventFragment, probe);
    } catch (error) {
      // No "Invalid event argument filters:" prefix here: the step handler
      // adds it when it wraps this error.
      throw new Error(
        `'${input.name}' (${input.type}): ${getErrorMessage(error)}`
      );
    }
  }
  return iface.encodeFilterTopics(eventFragment, [...fullArgs]);
}

function resolveEventFilter(
  contract: ethers.Contract,
  eventName: string,
  eventFragment: ethers.EventFragment | null,
  indexedArgs: (unknown | null)[]
): ethers.DeferredTopicFilter {
  // indexedArgs is positional over the event's indexed inputs (null = topic
  // wildcard). ethers expects args positional over ALL inputs, so expand
  // with null wildcards at non-indexed positions first. An empty array
  // reproduces the old match-all filter exactly.
  const fullArgs = eventFragment
    ? expandIndexedArgsToEventPositions(eventFragment, indexedArgs)
    : indexedArgs;
  const eventFilter = contract.filters[eventName]?.(...fullArgs);
  if (eventFilter === undefined || eventFilter === null) {
    throw new Error(`Could not create filter for event '${eventName}'`);
  }
  return eventFilter;
}

/**
 * Normalize the `eventArgs` step input into a positional array over the
 * event's indexed inputs, for eth_getLogs topic filtering via
 * `contract.filters[eventName](...indexedArgs)`.
 *
 * Accepts the same shapes as query-transactions' `functionArgs`: a JSON
 * array string or a raw array. Empty/unset input, and empty-string entries,
 * become `null` wildcards (match anything at that topic position). Only
 * indexed inputs are bound -- non-indexed event parameters can never become
 * topics, so they have no position in the returned array. Because ethers
 * maps filter args positionally over ALL event inputs, run the result
 * through `expandIndexedArgsToEventPositions` before passing it to
 * `contract.filters[eventName](...)` or `iface.encodeFilterTopics`.
 *
 * Values pass through `coerceArgsForAbi` (the same coercion write-contract
 * applies: `"true"`/`"false"` strings become booleans, template variables
 * pass through untouched).
 *
 * Throws on invalid JSON, non-array values, or more values than the event
 * has indexed inputs, so config errors surface before any RPC work happens.
 */
export function parseIndexedEventArgs(
  eventFragment: ethers.EventFragment,
  eventArgs: string | unknown[] | undefined
): (unknown | null)[] {
  const indexedInputs = eventFragment.inputs.filter((input) => input.indexed);

  let values: unknown[];
  if (eventArgs === undefined || eventArgs === null) {
    values = [];
  } else if (Array.isArray(eventArgs)) {
    values = eventArgs;
  } else if (typeof eventArgs === "string") {
    if (eventArgs.trim() === "") {
      values = [];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(eventArgs);
      } catch (error) {
        throw new Error(
          `eventArgs is not valid JSON: ${getErrorMessage(error)}`
        );
      }
      if (!Array.isArray(parsed)) {
        throw new Error("eventArgs must be a JSON array of argument values");
      }
      values = parsed;
    }
  } else {
    throw new Error("eventArgs must be a JSON array string or an array");
  }

  if (values.length > indexedInputs.length) {
    throw new Error(
      `eventArgs has ${values.length} value(s) but event '${eventFragment.name}' has only ${indexedInputs.length} indexed input(s)`
    );
  }

  // Pad short arrays with wildcards: a missing entry matches anything.
  const result: (unknown | null)[] = [];
  for (let i = 0; i < indexedInputs.length; i++) {
    const value = values[i];
    result.push(
      value === undefined || value === null || value === "" ? null : value
    );
  }

  return coerceArgsForAbi(result, { inputs: toAbiParams(indexedInputs) });
}

function toAbiParams(inputs: readonly ethers.ParamType[]): AbiParam[] {
  return inputs.map((input) => ({
    name: input.name,
    type: input.type,
    ...(input.components ? { components: toAbiParams(input.components) } : {}),
    indexed: input.indexed ?? undefined,
  }));
}

async function fetchFixedBatch(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  parsedAbi: AbiEntry[],
  eventName: string,
  start: number,
  end: number,
  indexedArgs: (unknown | null)[] = []
): Promise<BatchQueryResult> {
  const contract = new ethers.Contract(contractAddress, parsedAbi, provider);
  // Reuse the contract's own Interface: constructing a second one re-parses
  // the full ABI on every batch (and every retry attempt).
  const eventFragment = contract.interface.getEvent(eventName);
  const eventFilter = resolveEventFilter(
    contract,
    eventName,
    eventFragment,
    indexedArgs
  );
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
  start: number,
  indexedArgs: (unknown | null)[] = []
): Promise<BatchQueryResult> {
  const contract = new ethers.Contract(contractAddress, parsedAbi, provider);
  // Reuse the contract's own Interface: constructing a second one re-parses
  // the full ABI on every batch (and every retry attempt).
  const eventFragment = contract.interface.getEvent(eventName);
  const eventFilter = resolveEventFilter(
    contract,
    eventName,
    eventFragment,
    indexedArgs
  );
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
  isTipBatch: boolean,
  indexedArgs: (unknown | null)[] = []
): Promise<BatchQueryResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
    try {
      return await rpcManager.executeWithFailover((provider) =>
        isTipBatch
          ? fetchTipBatch(
              provider,
              contractAddress,
              parsedAbi,
              eventName,
              start,
              indexedArgs
            )
          : fetchFixedBatch(
              provider,
              contractAddress,
              parsedAbi,
              eventName,
              start,
              end,
              indexedArgs
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
