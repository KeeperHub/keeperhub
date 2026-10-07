// No "use step" directive: safe to export helpers and import from step files.
// Query Contract Events over several contract and event pairs in one node.

import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import type { BlockRange } from "./block-range-helpers";
import { buildEventArgTopics } from "./event-arg-filter-core";
import {
  type DecodedEvent,
  decodeEventArgs,
  type LogQueryFilter,
  parseAbi,
  QUERY_BATCH_SIZE,
  queryLogsWithRetry,
} from "./query-events-core";

export const MAX_EVENT_QUERIES = 20;

export type TaggedEvent = DecodedEvent & {
  contractAddress: string;
  eventName: string;
};

export type ResolvedEventQuery = {
  contractAddress: string;
  fragment: ethers.EventFragment;
  iface: ethers.Interface;
  // Compiled indexed-argument filter, or null for every occurrence.
  topics: (string | null)[] | null;
};

type LogQueryPlan = LogQueryFilter & {
  // The entries this call serves, keyed by logKey(address, topic0).
  queries: Map<string, ResolvedEventQuery>;
};

type Failure = { success: false; error: string; destinationError?: true };

type ParseEventQueriesResult =
  | { success: true; queries: ResolvedEventQuery[] }
  | Failure;

const LIST_SHAPE_ERROR =
  "Events must be a JSON array of entries, each with contractAddress, abi and eventName.";
const EMPTY_LIST_ERROR = "Add at least one event to query.";

function fail(error: string): Failure {
  return { success: false, error };
}

// No contract to query at all, which failOnError never softens.
function noDestination(error: string): Failure {
  return { success: false, destinationError: true, error };
}

function logKey(address: string, topic0: string): string {
  return `${address.toLowerCase()}:${topic0.toLowerCase()}`;
}

function readEntryList(
  raw: unknown
): { success: true; entries: unknown[] } | Failure {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") {
      return noDestination(EMPTY_LIST_ERROR);
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return noDestination(LIST_SHAPE_ERROR);
    }
  }
  if (value === undefined || value === null) {
    return noDestination(EMPTY_LIST_ERROR);
  }
  if (!Array.isArray(value)) {
    return noDestination(LIST_SHAPE_ERROR);
  }
  if (value.length === 0) {
    return noDestination(EMPTY_LIST_ERROR);
  }
  if (value.length > MAX_EVENT_QUERIES) {
    return fail(
      `${value.length} events are listed, more than the ${MAX_EVENT_QUERIES} one node can query. Split them across several nodes.`
    );
  }
  return { success: true, entries: value };
}

function resolveEventFragment(
  abi: string,
  eventName: string
):
  | { success: true; iface: ethers.Interface; fragment: ethers.EventFragment }
  | Failure {
  const abiResult = parseAbi(abi);
  if (!abiResult.success) {
    return abiResult;
  }
  const declared = abiResult.parsed.some(
    (item) => item.type === "event" && item.name === eventName
  );
  if (!declared) {
    return fail(`Event '${eventName}' not found in ABI`);
  }
  let iface: ethers.Interface;
  let fragment: ethers.EventFragment | null;
  try {
    iface = new ethers.Interface(abiResult.parsed);
    fragment = iface.getEvent(eventName);
  } catch (error) {
    return fail(getErrorMessage(error));
  }
  if (!fragment) {
    return fail(`Event '${eventName}' not found in contract interface`);
  }
  if (fragment.anonymous) {
    return fail(
      `Event '${eventName}' is anonymous, so its logs carry no signature topic to query by`
    );
  }
  return { success: true, iface, fragment };
}

// Anything but a string or record goes through as text for the compiler to reject.
function filterInput(
  value: unknown
): string | Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return String(value);
}

function resolveEntry(
  entry: unknown,
  index: number
): { success: true; query: ResolvedEventQuery } | Failure {
  const position = `Event ${index + 1}`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return noDestination(
      `${position} must be an object with contractAddress, abi and eventName.`
    );
  }
  const { contractAddress, abi, eventName, eventArgs } = entry as Record<
    string,
    unknown
  >;

  if (typeof contractAddress !== "string" || contractAddress === "") {
    return noDestination(`${position} is missing a contract address.`);
  }
  if (!ethers.isAddress(contractAddress)) {
    return noDestination(
      `${position} has an invalid contract address: ${contractAddress}`
    );
  }
  if (typeof eventName !== "string" || eventName === "") {
    return fail(`${position} is missing an event name.`);
  }
  const named = `${position} (${eventName})`;
  if (typeof abi !== "string" || abi.trim() === "") {
    return fail(`${named} is missing its contract ABI.`);
  }

  const resolved = resolveEventFragment(abi, eventName);
  if (!resolved.success) {
    return fail(`${named}: ${resolved.error}`);
  }
  const topicResult = buildEventArgTopics(
    filterInput(eventArgs),
    resolved.fragment
  );
  if (!topicResult.success) {
    return fail(`${named}: ${topicResult.error}`);
  }

  return {
    success: true,
    query: {
      contractAddress: ethers.getAddress(contractAddress),
      fragment: resolved.fragment,
      iface: resolved.iface,
      topics: topicResult.topics,
    },
  };
}

/** Validate every entry before any RPC call, naming the first one at fault. */
export function parseEventQueries(raw: unknown): ParseEventQueriesResult {
  const list = readEntryList(raw);
  if (!list.success) {
    return list;
  }
  const queries: ResolvedEventQuery[] = [];
  for (const [index, entry] of list.entries.entries()) {
    const result = resolveEntry(entry, index);
    if (!result.success) {
      return result;
    }
    queries.push(result.query);
  }
  return { success: true, queries };
}

/** Unfiltered entries share one call per set of events; a filtered one gets its own. */
export function planLogQueries(queries: ResolvedEventQuery[]): LogQueryPlan[] {
  const plans: LogQueryPlan[] = [];
  const unfilteredByAddress = new Map<
    string,
    { address: string; topic0s: Set<string>; queries: ResolvedEventQuery[] }
  >();

  for (const query of queries) {
    if (query.topics) {
      plans.push({
        addresses: [query.contractAddress],
        topics: query.topics,
        queries: new Map([
          [logKey(query.contractAddress, query.fragment.topicHash), query],
        ]),
      });
      continue;
    }
    const addressKey = query.contractAddress.toLowerCase();
    const group = unfilteredByAddress.get(addressKey) ?? {
      address: query.contractAddress,
      topic0s: new Set<string>(),
      queries: [],
    };
    group.topic0s.add(query.fragment.topicHash);
    group.queries.push(query);
    unfilteredByAddress.set(addressKey, group);
  }

  const sharedByEventSet = new Map<string, LogQueryPlan>();
  for (const group of unfilteredByAddress.values()) {
    const topic0s = [...group.topic0s].sort();
    const eventSetKey = topic0s.join(",");
    const plan = sharedByEventSet.get(eventSetKey) ?? {
      addresses: [],
      topics: [topic0s.length === 1 ? topic0s[0] : topic0s],
      queries: new Map<string, ResolvedEventQuery>(),
    };
    plan.addresses.push(group.address);
    for (const query of group.queries) {
      const key = logKey(query.contractAddress, query.fragment.topicHash);
      if (!plan.queries.has(key)) {
        plan.queries.set(key, query);
      }
    }
    sharedByEventSet.set(eventSetKey, plan);
  }

  return [...sharedByEventSet.values(), ...plans];
}

function decodeLog(
  log: ethers.Log,
  plan: LogQueryPlan
): TaggedEvent | undefined {
  const topic0 = log.topics[0];
  if (!topic0) {
    return;
  }
  const query = plan.queries.get(logKey(log.address, topic0));
  if (!query) {
    return;
  }
  let values: ethers.Result;
  try {
    values = query.iface.decodeEventLog(query.fragment, log.data, log.topics);
  } catch {
    // Same signature but a different indexed layout than this ABI declares.
    return;
  }
  return {
    contractAddress: log.address,
    eventName: query.fragment.name,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.index,
    args: decodeEventArgs(values, query.fragment),
  };
}

/** Every call over the same fixed batches, merged in block then log order, once per log. */
export async function queryPlannedEvents(
  rpcManager: RpcProviderManager,
  plans: LogQueryPlan[],
  range: BlockRange
): Promise<TaggedEvent[]> {
  const events: TaggedEvent[] = [];
  const seen = new Set<string>();

  for (
    let start = range.fromBlock;
    start <= range.toBlock;
    start += QUERY_BATCH_SIZE
  ) {
    const end = Math.min(start + QUERY_BATCH_SIZE - 1, range.toBlock);
    for (const plan of plans) {
      const logs = await queryLogsWithRetry(rpcManager, plan, start, end);
      for (const log of logs) {
        const event = decodeLog(log, plan);
        const identity = `${log.transactionHash}:${log.index}`;
        if (event && !seen.has(identity)) {
          seen.add(identity);
          events.push(event);
        }
      }
    }
  }

  return events.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
  );
}
