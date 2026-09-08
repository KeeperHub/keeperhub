import "server-only";
import { ethers, isError } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";

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
 *   4. Neither found AND other error      -> re-throw original.
 *
 * Caller invariants:
 * - txRequest must be fully populated (nonce, chainId, gas, fees). The helper
 *   does not failover during populateTransaction.
 * - `response.wait()` polls on the provider that successfully broadcast;
 *   wait-side failover is a separate concern.
 */
export async function submitSignedTransactionWithFailover(
  signer: ethers.Signer,
  txRequest: ethers.TransactionRequest,
  rpcManager: RpcProviderManager
): Promise<BroadcastResult> {
  const populated = await signer.populateTransaction(txRequest);
  const signedHex = await signer.signTransaction(populated);
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
  const receipt = await rpcManager.executeWithFailover(
    (provider) => provider.getTransactionReceipt(expectedHash),
    "read"
  );
  const pending = await rpcManager.executeWithFailover(
    (provider) => provider.getTransaction(expectedHash),
    "read"
  );

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
  if (isNonceConflictError(originalError)) {
    throw new NonceConflictError(
      expectedHash,
      typeof nonce === "number" ? nonce : null,
      originalError
    );
  }
  throw originalError;
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
