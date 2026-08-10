/**
 * KEEP-966: independent, synchronous on-chain verification of claimed
 * transaction hashes.
 *
 * This is the one place that re-checks a write's outcome against the chain
 * itself rather than trusting whatever `success` boolean the write path
 * self-reported. It is called from the two execution finalize chokepoints
 * (direct-execute's completeExecution, workflow's logWorkflowCompleteDb /
 * selfHealWorkflowAfterLateStepCommit) so that "completed" can only be
 * written once every claimed hash has independently verified.
 *
 * Deliberately fail-closed: any hash that can't be positively confirmed
 * within the bounded retry budget below (RPC timeout, receipt not yet
 * visible) resolves to `verified: false`, never `verified: true`.
 */
import "server-only";
import { ethers } from "ethers";
import { resolveRpcConfig } from "@/lib/rpc/config-service";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { RpcProviderManager } from "@/lib/rpc/providers";

export type ReceiptStatus =
  | "success"
  | "reverted"
  | "not_found"
  | "timeout"
  | "safe_inner_failure";

export type ReceiptVerificationResult = {
  hash: string;
  chainId: number;
  verified: boolean;
  status: ReceiptStatus;
  blockNumber?: number;
  gasUsed?: string;
  verifiedAt: string;
};

// Statuses where the chain gave an answer. The rest mean we could not read the
// receipt, which is not the same as the transaction having failed, and callers
// must be able to tell those apart before they settle anything as failed.
const CONCLUSIVE_STATUSES: ReadonlySet<ReceiptStatus> = new Set([
  "success",
  "reverted",
  "safe_inner_failure",
]);

export function isConclusiveReceiptStatus(status: ReceiptStatus): boolean {
  return CONCLUSIVE_STATUSES.has(status);
}

/**
 * True when at least one hash could not be read at all, so the batch's outcome
 * is unknown rather than failed.
 */
export function hasUnreadableReceipt(
  results: readonly { verified: boolean; status: ReceiptStatus }[]
): boolean {
  return results.some(
    (result) => !(result.verified || isConclusiveReceiptStatus(result.status))
  );
}

// The write path has already broadcast and waited for this receipt once before
// returning, so this is a fast independent re-fetch, not a fresh confirmation
// wait. Retries here only apply to attempts that throw: a null answer counts as
// a successful call, so they buy resilience against transport failures rather
// than against a lagging node.
const VERIFY_MAX_RETRIES = 5;
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_CONCURRENCY_LIMIT = 20;

// A single miss is not evidence of absence. RPC hosts sit behind load
// balancers, so the node that answers this read can be a block or two behind
// the one the write path used. A receipt has been observed being found and then
// reported missing 8ms later on the same chain, so re-ask before concluding it
// is not there.
//
// This bounds how many rounds start, not elapsed time: the deadline is only
// checked between rounds, so one already in flight runs to completion. Rounds
// against a responsive endpoint cost milliseconds, but a round whose endpoints
// time out instead of answering can overrun the budget by
// VERIFY_MAX_RETRIES x VERIFY_TIMEOUT_MS per provider, primary then fallback.
// That case only arises for a transaction no endpoint can see, which the
// unconfirmed state and the reconciler then own.
const LOOKUP_BUDGET_MS = 12_000;
const LOOKUP_RETRY_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Gnosis Safe's execTransaction always emits exactly one of these -- never
// neither. A receipt with status 1 (outer tx succeeded) can still carry
// ExecutionFailure when the wrapped inner call reverted; Safe swallows that
// as an event rather than reverting the whole transaction, so plain
// receipt.status checks miss it entirely.
//
// Reachability, verified on Sepolia against a real owner-signed Safe: this
// branch cannot fire for transactions KeeperHub itself builds.
// buildExecTransactionCalldata in lib/safe/allowance-module.ts passes
// safeTxGas=0, baseGas=0, gasPrice=0, and Safe's
// `require(success || safeTxGas != 0 || gasPrice != 0)` therefore reverts the
// whole outer transaction on inner failure -- receipt status 0, no logs,
// caught by the plain status check above. With safeTxGas non-zero the same
// call yields status 1 plus ExecutionFailure, which is what this decodes.
//
// It is kept because the cost is one topic comparison and the failure mode it
// covers is silent: any future path that submits a Safe transaction it did not
// construct (executing a queued transaction created in the Safe UI, say, where
// safeTxGas is set by the proposer) reaches it immediately. Do not delete this
// on the grounds that nothing currently triggers it -- delete it only if Safe
// support itself is removed.
const SAFE_EXECUTION_EVENTS_ABI = [
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
] as const;
const safeEventsInterface = new ethers.Interface(SAFE_EXECUTION_EVENTS_ABI);
// Non-null: the ABI fragment above is a fixed, valid literal, so this always resolves.
const SAFE_EXECUTION_FAILURE_TOPIC =
  safeEventsInterface.getEvent("ExecutionFailure")?.topicHash;

function hasSafeExecutionFailureLog(
  receipt: ethers.TransactionReceipt
): boolean {
  return receipt.logs.some(
    (log) => log.topics[0] === SAFE_EXECUTION_FAILURE_TOPIC
  );
}

async function buildVerificationManager(
  chainId: number
): Promise<RpcProviderManager | null> {
  const config = await resolveRpcConfig(chainId);
  if (!config) {
    return null;
  }
  return new RpcProviderManager({
    config: {
      primaryRpcUrl: config.primaryRpcUrl,
      fallbackRpcUrl: config.fallbackRpcUrl,
      chainName: config.chainName,
      chainId,
      maxRetries: VERIFY_MAX_RETRIES,
      timeoutMs: VERIFY_TIMEOUT_MS,
    },
  });
}

type ReceiptLookup = {
  receipt: ethers.TransactionReceipt | null;
  /** True when at least one read errored rather than answering "no receipt". */
  errored: boolean;
};

/** Shrinkable in tests so the retry budget does not add wall-clock time. */
export type ReceiptLookupOptions = {
  budgetMs?: number;
  retryDelayMs?: number;
};

/**
 * Ask every available endpoint for the receipt, repeatedly, until one answers
 * or the budget runs out.
 *
 * `getTransactionReceipt` resolves to null for an unknown hash rather than
 * throwing, so `executeWithFailover` treats a miss as a successful call and
 * never moves to the fallback endpoint. That makes the fallback unreachable
 * for exactly the case it exists to cover, so a null answer is followed by an
 * explicit read against the fallback provider.
 */
async function lookupReceipt(
  hash: string,
  manager: RpcProviderManager,
  options: ReceiptLookupOptions = {}
): Promise<ReceiptLookup> {
  const budgetMs = options.budgetMs ?? LOOKUP_BUDGET_MS;
  const retryDelayMs = options.retryDelayMs ?? LOOKUP_RETRY_DELAY_MS;
  const deadline = Date.now() + budgetMs;
  let errored = false;
  let firstRound = true;

  while (firstRound || Date.now() < deadline) {
    if (!firstRound) {
      await sleep(retryDelayMs);
    }
    firstRound = false;

    try {
      const receipt = await manager.executeWithFailover(
        (provider) => provider.getTransactionReceipt(hash),
        "read"
      );
      if (receipt) {
        return { receipt, errored: false };
      }
    } catch {
      errored = true;
    }

    const fallback = manager.getFallbackProvider();
    if (fallback) {
      try {
        const receipt = await fallback.getTransactionReceipt(hash);
        if (receipt) {
          return { receipt, errored: false };
        }
      } catch {
        errored = true;
      }
    }
  }

  return { receipt: null, errored };
}

async function verifySingleReceipt(
  hash: string,
  chainId: number,
  manager: RpcProviderManager,
  options: ReceiptLookupOptions = {}
): Promise<ReceiptVerificationResult> {
  const verifiedAt = new Date().toISOString();

  const { receipt, errored } = await lookupReceipt(hash, manager, options);

  if (!receipt) {
    return {
      hash,
      chainId,
      verified: false,
      // "Every endpoint errored" and "every endpoint answered, none had it"
      // are different operational problems, so keep them distinguishable.
      status: errored ? "timeout" : "not_found",
      verifiedAt,
    };
  }

  const blockNumber = receipt.blockNumber;
  const gasUsed = receipt.gasUsed.toString();

  if (receipt.status === 0) {
    return {
      hash,
      chainId,
      verified: false,
      status: "reverted",
      blockNumber,
      gasUsed,
      verifiedAt,
    };
  }

  if (hasSafeExecutionFailureLog(receipt)) {
    return {
      hash,
      chainId,
      verified: false,
      status: "safe_inner_failure",
      blockNumber,
      gasUsed,
      verifiedAt,
    };
  }

  return {
    hash,
    chainId,
    verified: true,
    status: "success",
    blockNumber,
    gasUsed,
    verifiedAt,
  };
}

/**
 * Inline concurrency cap (no new dependency, matches the established
 * pattern in lib/mcp/validate-workflow-deep.ts). Order of `results` matches
 * `items`.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const myIndex = cursor;
      cursor += 1;
      const item = items[myIndex];
      if (item === undefined) {
        break;
      }
      results[myIndex] = await worker(item);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker)
  );

  return results;
}

/**
 * Independently re-verifies every claimed transaction hash against the
 * chain. Groups by chainId so each distinct chain only pays for one
 * RpcProviderManager, then verifies all hashes concurrently (capped).
 *
 * Solana chainIds are passed through as verified/success without an
 * on-chain check: lib/web3/chain-adapter/solana.ts is entirely stubbed
 * today (every write method throws "not implemented"), so no live code
 * path can produce a Solana hash here -- this is a defensive carve-out, not
 * a known gap, and fail-closing it would be a functional regression rather
 * than a safety fix if a Solana write path ever ships.
 */
export async function verifyExecutionReceipts(
  hashes: { hash: string; chainId: number }[],
  options: ReceiptLookupOptions = {}
): Promise<{ allVerified: boolean; results: ReceiptVerificationResult[] }> {
  if (hashes.length === 0) {
    return { allVerified: true, results: [] };
  }

  const groups = new Map<number, { hash: string; chainId: number }[]>();
  for (const entry of hashes) {
    const list = groups.get(entry.chainId) ?? [];
    list.push(entry);
    groups.set(entry.chainId, list);
  }

  const allResults: ReceiptVerificationResult[] = [];

  for (const [chainId, group] of groups) {
    if (isSolanaChain(chainId)) {
      const verifiedAt = new Date().toISOString();
      for (const { hash } of group) {
        allResults.push({
          hash,
          chainId,
          verified: true,
          status: "success",
          verifiedAt,
        });
      }
      continue;
    }

    const manager = await buildVerificationManager(chainId);
    if (!manager) {
      const verifiedAt = new Date().toISOString();
      for (const { hash } of group) {
        allResults.push({
          hash,
          chainId,
          verified: false,
          status: "timeout",
          verifiedAt,
        });
      }
      continue;
    }

    const groupResults = await mapWithConcurrency(
      group,
      VERIFY_CONCURRENCY_LIMIT,
      ({ hash }) => verifySingleReceipt(hash, chainId, manager, options)
    );
    allResults.push(...groupResults);
  }

  return {
    allVerified: allResults.every((result) => result.verified),
    results: allResults,
  };
}

function describeStatus(status: ReceiptStatus): string {
  switch (status) {
    case "reverted":
      return "reverted on-chain";
    case "safe_inner_failure":
      return "Safe inner call failed (ExecutionFailure event)";
    case "not_found":
      return "receipt not found";
    case "timeout":
      return "RPC verification timed out";
    default:
      return status;
  }
}

/**
 * Human-readable summary of the failed entries in a verification result,
 * for persisting as the execution's error message. Wording is deliberately
 * stable ("reverted on-chain", "receipt not found", "verification timed
 * out") so lib/errors/classify.ts can route these into the right
 * errorCategory/errorType bucket.
 */
export function describeVerificationFailure(
  results: ReceiptVerificationResult[]
): string {
  const failed = results.filter((result) => !result.verified);
  if (failed.length === 0) {
    return "On-chain verification failed";
  }
  const parts = failed.map(
    (result) => `${result.hash} (${describeStatus(result.status)})`
  );
  return `On-chain verification failed for ${failed.length} transaction${
    failed.length > 1 ? "s" : ""
  }: ${parts.join(", ")}`;
}
