import "server-only";
import { ethers, isError } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { OnChainPendingError } from "@/lib/web3/onchain-revert";

export type BroadcastResult = {
  hash: string;
  response: ethers.TransactionResponse;
  preExistingReceipt?: ethers.TransactionReceipt;
};

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
  // mechanically-known case. Timeouts/dropped replies are deliberately NOT in
  // this list because the node may have accepted the signed bytes first.
  if (isDefinitelyPreBroadcastNetworkError(originalError)) {
    throw originalError;
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

export function isDefinitelyPreBroadcastNetworkError(error: unknown): boolean {
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
