/**
 * KEEP-1541: In-memory tracker for step successes within a workflow execution.
 *
 * Both withStepLogging (step-handler.ts) and the workflow executor run in the
 * same Node.js process, so a module-level Map is sufficient. This replaces the
 * HTTP loopback approach that failed silently in production.
 *
 * Only successes are tracked. The reconciler treats a tracked success as proof
 * that the step completed, regardless of subsequent SDK retry errors. This is
 * safe because withStepLogging records success only after the step function
 * returns without error -- the "max retries exceeded" error originates from
 * the SDK's durability layer, not from the step itself.
 *
 * KEEP-543: tracker is now iteration-aware. Body nodes inside a parallel For
 * Each loop execute once per iteration with the same nodeId; the iteration
 * key (forEachNodeId + iterationIndex) disambiguates them so spurious-recovery
 * inside the body runner returns the correct iteration's output instead of
 * whichever iteration was last to record.
 *
 * Lifecycle:
 *   1. withStepLogging calls recordStepSuccess() after each successful step
 *      (with iterationKey when the step ran inside a For Each iteration)
 *   2. The executor / body runner calls getStepSuccess() during max-retries
 *      reconciliation, threading the iteration key when applicable
 *   3. The executor calls clearExecution() in a finally block to free memory
 */

import type { TransactionHashEntry } from "@/lib/db/schema";
import { isSolanaChain } from "@/lib/rpc/solana-chains";
import { validateChainTxHash } from "@/lib/web3/validate-chain-tx-hash";
import type { StepContext } from "./step-handler";

/**
 * Whether a step's self-reported hash is one this execution can record and
 * later re-verify against the chain.
 *
 * Solana signatures are base58, not 0x-hex, so a bare 0x prefix test drops
 * every one of them and the finalize gate never sees a Solana write at all.
 * When the step reported which chain it was on, the hash is instead checked
 * against the shape that chain actually uses (validateChainTxHash), which
 * still rejects junk.
 *
 * A hash with no chainId keeps the 0x test on purpose. reconcileTransactionHashes
 * fails the whole batch conclusively for a hash it cannot attribute to a chain,
 * so admitting a base58 hash from a step that reports no chainId
 * (transfer-spl-token-core, call-solana-program-core,
 * send-raw-solana-instruction-core) would settle runs that actually succeeded
 * as failed. Those steps not reporting chainId is a separate defect; dropping
 * their hash is what happens today and is the lesser of the two errors until
 * it is fixed.
 *
 * Both helpers are imported from leaf modules rather than provider-factory /
 * validate-chain-address: this file is reachable from executor.workflow.ts,
 * so whatever it imports is compiled into the workflow-function bundle, where
 * @solana/web3.js, ethers, safeFetch and the db client are all rejected.
 */
export function isRecordableTransactionHash(
  hash: string,
  chainId: unknown
): boolean {
  if (typeof chainId === "number" && isSolanaChain(chainId)) {
    return validateChainTxHash(hash, chainId);
  }
  return hash.startsWith("0x");
}

/** A hash a step output reports, before node and iteration context is added. */
export type OutputTransactionHash = {
  hash: string;
  chainId?: number;
  network?: string;
  legIndex?: number;
};

/**
 * Every recordable hash a step output reports.
 *
 * Most write steps send one transaction and report it as `transactionHash`. A
 * step that sends several - web3/disburse, one transaction per leg - reports
 * them in `legTransactions` instead, each with its leg index. Reading only
 * `transactionHash` would record and re-verify one leg and silently drop the
 * rest. Shared by this tracker and the log-row harvest in logging.ts so the
 * two reconstructions cannot drift apart.
 */
export function transactionHashesFromOutput(
  output: unknown
): OutputTransactionHash[] {
  if (output === null || typeof output !== "object") {
    return [];
  }
  const o = output as {
    transactionHash?: unknown;
    chainId?: unknown;
    network?: unknown;
    legTransactions?: unknown;
  };
  const chainId = typeof o.chainId === "number" ? o.chainId : undefined;
  const network = typeof o.network === "string" ? o.network : undefined;
  const found: OutputTransactionHash[] = [];
  if (
    typeof o.transactionHash === "string" &&
    isRecordableTransactionHash(o.transactionHash, o.chainId)
  ) {
    found.push({
      hash: o.transactionHash,
      ...(chainId !== undefined && { chainId }),
      ...(network !== undefined && { network }),
    });
  }
  if (Array.isArray(o.legTransactions)) {
    for (const item of o.legTransactions as unknown[]) {
      const leg = item as {
        hash?: unknown;
        chainId?: unknown;
        legIndex?: unknown;
      } | null;
      if (leg === null || typeof leg !== "object") {
        continue;
      }
      const legChainId =
        typeof leg.chainId === "number" ? leg.chainId : chainId;
      if (
        typeof leg.hash !== "string" ||
        !isRecordableTransactionHash(leg.hash, legChainId)
      ) {
        continue;
      }
      found.push({
        hash: leg.hash,
        ...(legChainId !== undefined && { chainId: legChainId }),
        ...(network !== undefined && { network }),
        ...(typeof leg.legIndex === "number" && { legIndex: leg.legIndex }),
      });
    }
  }
  return found;
}

export type IterationKey = {
  forEachNodeId: string;
  iterationIndex: number;
};

const executions = new Map<string, Map<string, unknown>>();
const txHashEntries = new Map<string, TransactionHashEntry[]>();

function composeKey(nodeId: string, iterationKey?: IterationKey): string {
  if (!iterationKey) {
    return nodeId;
  }
  return `${nodeId}::${iterationKey.forEachNodeId}::${iterationKey.iterationIndex}`;
}

export function recordStepSuccess(
  executionId: string,
  nodeId: string,
  output: unknown,
  iterationKey?: IterationKey
): void {
  let steps = executions.get(executionId);
  if (steps === undefined) {
    steps = new Map<string, unknown>();
    executions.set(executionId, steps);
  }
  steps.set(composeKey(nodeId, iterationKey), output);
}

/**
 * Look up a tracked success for a specific (execution, node, iteration). When
 * iterationKey is omitted, the top-level entry is returned. Returns undefined
 * when no entry exists.
 */
export function getStepSuccess(
  executionId: string,
  nodeId: string,
  iterationKey?: IterationKey
): { output: unknown } | undefined {
  const steps = executions.get(executionId);
  if (steps === undefined) {
    return;
  }
  const key = composeKey(nodeId, iterationKey);
  if (!steps.has(key)) {
    return;
  }
  return { output: steps.get(key) };
}

/**
 * Returns the per-execution Map of tracked successes (composite-keyed). Used by
 * cold-pod degradation detection at convergence sites -- callers only check
 * presence, not key shape, so iteration entries don't affect their behaviour.
 */
export function getSuccessfulSteps(
  executionId: string
): Map<string, unknown> | undefined {
  return executions.get(executionId);
}

/**
 * If the step output carries a recordable on-chain transaction hash (see
 * isRecordableTransactionHash), append it to the per-execution ordered list
 * along with the node and chain context that produced it. Called from
 * withStepLoggingInner after each successful step.
 *
 * Optional fields (chainId, network, iterationIndex) are omitted from the
 * entry rather than set to null when not present in the output / context,
 * keeping the persisted JSON clean and making `if ("chainId" in entry)`
 * checks meaningful on the consumer side.
 */
export function recordTransactionHashIfPresent(
  context: StepContext,
  output: unknown
): void {
  if (context.executionId === undefined) {
    return;
  }
  const hashes = transactionHashesFromOutput(output);
  if (hashes.length === 0) {
    return;
  }
  const list = txHashEntries.get(context.executionId) ?? [];
  for (const found of hashes) {
    const entry: TransactionHashEntry = {
      hash: found.hash,
      nodeId: context.nodeId,
      nodeName: context.nodeName,
      ...(found.chainId !== undefined && { chainId: found.chainId }),
      ...(found.network !== undefined && { network: found.network }),
      ...(typeof context.iterationIndex === "number" && {
        iterationIndex: context.iterationIndex,
      }),
      ...(found.legIndex !== undefined && { legIndex: found.legIndex }),
    };
    // One on-chain write, one entry. A step can be recorded more than once for
    // the same node -- a replay that reuses a completed step records it so the
    // tracker stays complete -- and resolveTransactionHashesForSuccess feeds
    // this list straight into the run's transactionHashes, so a duplicate would
    // be re-verified against the chain and counted twice in the digest.
    const alreadyTracked = list.some(
      (existing) =>
        existing.hash === entry.hash &&
        existing.nodeId === entry.nodeId &&
        existing.iterationIndex === entry.iterationIndex
    );
    if (!alreadyTracked) {
      list.push(entry);
    }
  }
  txHashEntries.set(context.executionId, list);
}

/**
 * Returns a shallow copy of the tracked entries so callers cannot mutate
 * the internal list. resolveTransactionHashesForSuccess feeds this directly
 * into a DB UPDATE; without the copy, any future caller that mutates the
 * returned array (push, splice, reverse) would silently mutate the
 * tracker's state for the entire process lifetime of that execution.
 */
export function getTransactionHashes(
  executionId: string
): TransactionHashEntry[] {
  const list = txHashEntries.get(executionId);
  return list === undefined ? [] : [...list];
}

export function clearExecution(executionId: string): void {
  executions.delete(executionId);
  txHashEntries.delete(executionId);
}
