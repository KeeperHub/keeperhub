import "server-only";
import { ethers, isError } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { OnChainPendingError } from "@/lib/web3/onchain-revert";

export type BroadcastResult = {
  hash: string;
  response: ethers.TransactionResponse;
  /**
   * Populated only when on-chain reconciliation found the tx already mined
   * before/during our broadcast attempt. Callers may skip `response.wait()`.
   */
  preExistingReceipt?: ethers.TransactionReceipt;
};

/**
 * Thrown when broadcast failed AND on-chain reconciliation found no trace of
 * the signed transaction. The nonce slot was consumed by a different tx;
 * callers should treat the nonce as lost and resync from chain state.
 */
export class NonceConflictError extends Error {
  override readonly name = "NonceConflictError" as const;
  readonly expectedHash: string;
  readonly nonce: number | null;
  override readonly cause: unknown;

  constructor(expectedHash: string, nonce: number | null, cause: unknown) {
    super(
      `Broadcast for ${expectedHash} (nonce ${nonce ?? "unknown"}) failed; ` +
        "nonce slot was consumed by a different transaction."
    );
    this.expectedHash = expectedHash;
    this.nonce = nonce;
    this.cause = cause;
  }
}

/**
 * A broadcast attempt refused before the request could have reached the
 * node: the tagged, provenance-carrying form of a pre-broadcast network
 * failure.
 *
 * The disposition layer (lib/idempotency-disposition.ts) releases an
 * idempotency key on `broadcastAttempted: false`, so the signal that
 * nothing was sent must not be inferred from message text at a core catch
 * that wraps the whole send-and-confirm try. An ECONNREFUSED surfaced by
 * the post-broadcast receipt poll, or by the nonce bookkeeping insert,
 * reads identically to a refused send while meaning the transaction may
 * already sit in the mempool. The tag is applied here, at the one point
 * where the refusal is known to come from the broadcast call itself; cores
 * test the marker with `isPreBroadcastNetworkError`, never the message.
 */
export class PreBroadcastNetworkError extends Error {
  override readonly name = "PreBroadcastNetworkError" as const;
  readonly kind = "pre-broadcast" as const;
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Duck-typed, not `instanceof`: modules that import `server-only` peers can
 * be instantiated in more than one module registry, where the classes are
 * distinct and `instanceof` silently misses. Same discipline as
 * lib/web3/onchain-revert.ts.
 */
export function isPreBroadcastNetworkError(
  error: unknown
): error is PreBroadcastNetworkError {
  return (
    error instanceof Error &&
    (error as PreBroadcastNetworkError).kind === "pre-broadcast"
  );
}

/**
 * Sign once, broadcast with RPC failover, reconcile on error.
 *
 * Wrapping `signer.sendTransaction` in failover is unsafe because ethers
 * re-populates and re-signs on each retry, producing different signed bytes
 * (different gas, possibly stale nonce). This helper signs once so the tx
 * hash is fixed before any retry.
 *
 * On broadcast error, "already known" / "nonce too low" / "replacement
 * underpriced" cannot be distinguished by message alone: each can mean
 * either "our tx already landed somewhere" or "a competing tx took our
 * nonce." We disambiguate by on-chain lookup:
 *   1. getTransactionReceipt(expectedHash) -> if found, tx mined; success.
 *   2. getTransaction(expectedHash)        -> if found, in mempool; success.
 *   3. Neither found AND error looks like nonce conflict -> NonceConflictError.
 *   4. Neither found AND other error      -> reconcile by certainty: a
 *      definite pre-broadcast refusal is tagged PreBroadcastNetworkError,
 *      anything else carries the hash as OnChainPendingError, because the
 *      send may have landed.
 *
 * Caller invariants:
 * - txRequest must be fully populated (nonce, chainId, gas, fees). The helper
 *   does not failover during populateTransaction.
 * - `response.wait()` polls on the provider that successfully broadcast;
 *   wait-side failover is a separate concern.
 *
 * The signed bytes determine the hash before broadcast. That fact closes the
 * #1840 ambiguity: a pre-broadcast rejection has no hash, while a send whose
 * reply was lost keeps this deterministic hash and is held/reconciled rather
 * than becoming indistinguishable from "never sent".
 */
export async function submitSignedTransactionWithFailover(
  signer: ethers.Signer,
  txRequest: ethers.TransactionRequest,
  rpcManager: RpcProviderManager
): Promise<BroadcastResult> {
  let populated: ethers.TransactionRequest;
  let signedHex: string;
  try {
    populated = await signer.populateTransaction(txRequest);
    signedHex = await signer.signTransaction(populated);
  } catch (error) {
    // No broadcast call has started. Preserve that provenance structurally so
    // callers can release an idempotency key without matching error text.
    throw new PreBroadcastNetworkError(errorMessage(error), error);
  }
  const expectedHash = computeTxHash(signedHex);

  try {
    const response = await rpcManager.executeWithFailover(
      (provider) => provider.broadcastTransaction(signedHex),
      "write-broadcast"
    );
    return { hash: response.hash, response };
  } catch (err) {
    return await reconcile(rpcManager, expectedHash, populated.nonce, err);
  }
}

function computeTxHash(signedHex: string): string {
  const tx = ethers.Transaction.from(signedHex);
  if (!tx.hash) {
    throw new Error("Failed to derive transaction hash from signed bytes");
  }
  return tx.hash;
}

async function reconcile(
  rpcManager: RpcProviderManager,
  expectedHash: string,
  nonce: number | null | undefined,
  originalError: unknown
): Promise<BroadcastResult> {
  let receipt: ethers.TransactionReceipt | null;
  let pending: ethers.TransactionResponse | null;
  try {
    receipt = await rpcManager.executeWithFailover(
      (provider) => provider.getTransactionReceipt(expectedHash),
      "read"
    );
    pending = await rpcManager.executeWithFailover(
      (provider) => provider.getTransaction(expectedHash),
      "read"
    );
  } catch (reconcileError) {
    throw pendingBroadcast(expectedHash, reconcileError);
  }

  if (receipt && pending) {
    return {
      hash: expectedHash,
      response: pending,
      preExistingReceipt: receipt,
    };
  }
  if (pending) {
    return { hash: expectedHash, response: pending };
  }
  if (receipt) {
    throw pendingBroadcast(expectedHash, originalError);
  }
  if (isNonceConflictError(originalError)) {
    throw new NonceConflictError(
      expectedHash,
      typeof nonce === "number" ? nonce : null,
      originalError
    );
  }

  // A refused TCP connection is genuinely pre-broadcast: the peer never
  // accepted a request. Preserve the existing terminal behaviour for that
  // mechanically-known case, tagging it at the point of provenance rather
  // than rethrowing a bare error whose text a downstream catch would have to
  // re-interpret. Timeouts/dropped replies are deliberately NOT in this list
  // because the node may have accepted the signed bytes first.
  if (isDefinitelyPreBroadcastNetworkError(originalError)) {
    throw new PreBroadcastNetworkError(
      errorMessage(originalError),
      originalError
    );
  }

  throw pendingBroadcast(expectedHash, originalError);
}

function pendingBroadcast(
  transactionHash: string,
  cause: unknown
): OnChainPendingError {
  return new OnChainPendingError({
    message: `Transaction send outcome could not be determined (${errorMessage(cause)})`,
    transactionHash,
  });
}

const RPC_FAILOVER_ENDPOINT_SPLIT = /\b(?:primary|fallback):\s*/i;

/**
 * Message-level heuristic for "the broadcast request never left the box".
 *
 * Apply this only where the error's provenance is already established -- a
 * catch that wraps the broadcast call alone, like the reconcile ladder above
 * or the Tempo send catch in tempo-tx-core.ts. In a catch covering more
 * than the send, an unrelated ECONNREFUSED (receipt poll, bookkeeping
 * insert) reads identically, and text-matching there is what lets a live
 * transaction look safe to retry. Past the send boundary, test the
 * PreBroadcastNetworkError marker instead.
 */
export function isDefinitelyPreBroadcastNetworkError(error: unknown): boolean {
  if (error instanceof Error && "allAttemptsConnectionRefused" in error) {
    const aggregate = (
      error as Error & { allAttemptsConnectionRefused?: unknown }
    ).allAttemptsConnectionRefused;
    if (typeof aggregate === "boolean") {
      return aggregate;
    }
  }

  const message = errorMessage(error).toLowerCase();
  const endpointFailures = message
    .split(RPC_FAILOVER_ENDPOINT_SPLIT)
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean);

  if (endpointFailures.length > 0) {
    return endpointFailures.every(isConnectionRefusal);
  }

  return isConnectionRefusal(message);
}

function isConnectionRefusal(message: string): boolean {
  return (
    message.includes("econnrefused") || message.includes("connection refused")
  );
}

/**
 * Recognise nonce-conflict errors across two layers:
 *
 * 1. Direct EthersError thrown from broadcastTransaction. ethers v6 translates
 *    raw node messages to typed codes in provider-jsonrpc.ts :: getRpcError:
 *      - "nonce too low" / "transaction nonce is too low" -> NONCE_EXPIRED
 *      - "replacement transaction underpriced"            -> REPLACEMENT_UNDERPRICED
 *    These are matched by code via isError(...).
 *
 * 2. Wrapped Error thrown by rpcManager.executeWithFailover when both
 *    endpoints fail. It re-throws a plain Error with the inner error
 *    messages interpolated as text, dropping the typed code. We fall back
 *    to substring matching on the message for those cases.
 *
 * The substring list covers BOTH raw node phrasings AND the canonical text
 * ethers picks when it constructs the typed error (e.g. "nonce has already
 * been used" is ethers' NONCE_EXPIRED message, distinct from the raw node
 * "nonce too low"). geth's ErrAlreadyKnown is not translated by ethers at
 * all, so its raw text is included too.
 */
const NONCE_CONFLICT_MESSAGE_PATTERNS: readonly string[] = [
  "already known",
  "known transaction",
  "nonce too low",
  "nonce is too low",
  "nonce has already been used",
  "replacement transaction underpriced",
  "replacement underpriced",
  "replacement fee too low",
];

export function isNonceConflictError(err: unknown): boolean {
  if (isError(err, "NONCE_EXPIRED")) {
    return true;
  }
  if (isError(err, "REPLACEMENT_UNDERPRICED")) {
    return true;
  }
  const msg = errorMessage(err).toLowerCase();
  return NONCE_CONFLICT_MESSAGE_PATTERNS.some((pattern) =>
    msg.includes(pattern)
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return String(err);
}
