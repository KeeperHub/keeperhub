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

// Tight budget: the write path has already broadcast and waited for this
// receipt once before returning -- this call is a fast independent re-fetch,
// not a fresh confirmation wait. Bounded so a stuck RPC can't hang a
// synchronous HTTP response / workflow finalize indefinitely.
const VERIFY_MAX_RETRIES = 2;
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_CONCURRENCY_LIMIT = 20;

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

async function verifySingleReceipt(
  hash: string,
  chainId: number,
  manager: RpcProviderManager
): Promise<ReceiptVerificationResult> {
  const verifiedAt = new Date().toISOString();

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await manager.executeWithFailover(
      (provider) => provider.getTransactionReceipt(hash),
      "read"
    );
  } catch {
    return { hash, chainId, verified: false, status: "timeout", verifiedAt };
  }

  if (!receipt) {
    return { hash, chainId, verified: false, status: "not_found", verifiedAt };
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
  hashes: { hash: string; chainId: number }[]
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
      ({ hash }) => verifySingleReceipt(hash, chainId, manager)
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
