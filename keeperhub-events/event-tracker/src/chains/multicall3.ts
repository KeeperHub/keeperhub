import { ethers } from "ethers";

/**
 * Multicall3 batching for state reads (issue #2240).
 *
 * `provider-manager.ts` already documents why log delivery uses a block
 * subscription plus batched `eth_getLogs` rather than one subscription per
 * listener: it decouples RPC-side cost from workflow count. A state trigger
 * that issued its own `eth_call` per subscription would give that property
 * back. Batching every state subscription on a chain into one `aggregate3`
 * restores it - one additional call per chain per drain, whatever the
 * subscription count.
 *
 * `aggregate3` rather than `aggregate` because it takes `allowFailure` per
 * call: one reverting view function then fails in its own slot instead of
 * reverting the batch and costing every other subscription on the chain its
 * sample.
 */

/**
 * Canonical Multicall3 deployment address, identical across the chains that
 * have it. Presence is probed per chain rather than assumed - see
 * `ChainProviderManager.probeMulticall3`. A contributor's `eth_getCode` sweep
 * on issue #2240 found it on all 11 configured mainnets, which is a statement
 * about the chain table as it stood on one day, and the table grows.
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Local ABI slice rather than an import from the monorepo root's
 * `lib/contracts`. `@techops/events-tracker` is a standalone package
 * (`rootDir: "."`, `include: ["src/**", "lib/**"]` scoped to its own `lib/`)
 * and cannot resolve modules above itself, the same constraint `in-flight.ts`
 * documents for its copy of the executor's tracker.
 */
const AGGREGATE3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
];

const aggregate3Interface = new ethers.Interface(AGGREGATE3_ABI);

/**
 * Calls per `aggregate3`. Every call in a batch shares one `eth_call`, so the
 * batch is bounded by the node's `eth_call` gas cap rather than by response
 * size: above it the whole batch fails, taking every subscription on the chain
 * with it. Caps are commonly 10-50M and a view like Aave's
 * `getUserAccountData` costs a few hundred thousand, so 50 keeps a batch
 * inside the tightest of those with room to spare. Chunking also bounds the
 * blast radius of a batch that fails for any other reason: it costs its own
 * chunk a sample, not the chain. Analogous in role to
 * `GETLOGS_MAX_BLOCK_SPAN`.
 */
export const STATE_CALL_MAX_BATCH = 50;

export interface Aggregate3Call {
  target: string;
  callData: string;
}

export interface Aggregate3Result {
  success: boolean;
  returnData: string;
}

/** Encode one `aggregate3` batch to calldata ready for `eth_call`. */
export function encodeAggregate3(calls: Aggregate3Call[]): string {
  return aggregate3Interface.encodeFunctionData("aggregate3", [
    calls.map((call) => ({
      target: call.target,
      allowFailure: true,
      callData: call.callData,
    })),
  ]);
}

/** Decode an `aggregate3` return into one slot per call, in call order. */
export function decodeAggregate3(returnData: string): Aggregate3Result[] {
  const [results] = aggregate3Interface.decodeFunctionResult(
    "aggregate3",
    returnData,
  );
  return (results as Array<{ success: boolean; returnData: string }>).map(
    (slot) => ({ success: slot.success, returnData: slot.returnData }),
  );
}

/** Split a list into `STATE_CALL_MAX_BATCH`-sized chunks. */
export function chunkCalls<T>(items: T[], size = STATE_CALL_MAX_BATCH): T[][] {
  const bounded = size > 0 ? size : STATE_CALL_MAX_BATCH;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += bounded) {
    chunks.push(items.slice(i, i + bounded));
  }
  return chunks;
}
