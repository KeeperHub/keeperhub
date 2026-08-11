import "server-only";
import {
  type SignatureStatus,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";

function extractFirstSignature(signedBytes: Uint8Array): Uint8Array | null {
  try {
    const sig = VersionedTransaction.deserialize(signedBytes).signatures[0];
    return sig ?? null;
  } catch {
    try {
      const legacySig = Transaction.from(signedBytes).signatures[0]?.signature;
      if (!legacySig) {
        return null;
      }
      return legacySig instanceof Buffer
        ? new Uint8Array(legacySig)
        : legacySig;
    } catch {
      return null;
    }
  }
}

/**
 * The base58 signature a set of signed bytes will carry on chain, or null when
 * the bytes cannot be parsed. Deterministic: the signature is fixed at signing,
 * so it identifies the transaction before it is ever broadcast.
 */
export function deriveSolanaSignature(signedBytes: Uint8Array): string | null {
  const firstSig = extractFirstSignature(signedBytes);
  return firstSig ? bs58.encode(firstSig) : null;
}

/**
 * Attempts before giving up on a signature that has not surfaced yet. A
 * transaction the RPC accepted needs a slot or two to become queryable, so a
 * single immediate lookup cannot tell "still propagating" from "never landed"
 * and would report a live transaction as failed.
 */
export const RECONCILE_ATTEMPTS = 5;
export const RECONCILE_DELAY_MS = 1500;

/** Overrides for the reconcile poll. Exists so tests need not sleep. */
export type ReconcileOptions = {
  attempts?: number;
  delayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls a signature's on-chain status, tolerating the indexing lag that follows
 * a broadcast. Returns true only for a confirmed/finalized transaction with no
 * execution error; an explicit on-chain error short-circuits to false, and an
 * unknown signature stays unknown until the attempts run out.
 */
async function isSignatureConfirmed(
  signature: string,
  manager: SolanaProviderManager,
  options: ReconcileOptions
): Promise<boolean> {
  const attempts = options.attempts ?? RECONCILE_ATTEMPTS;
  const delayMs = options.delayMs ?? RECONCILE_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(delayMs);
    }

    let statusResult: SignatureStatus | null = null;
    try {
      statusResult = await manager.executeWithFailover(async (connection) => {
        const res = await connection.getSignatureStatuses([signature]);
        return res.value[0];
      }, "read");
    } catch {
      // A read that fails on every endpoint says nothing about the
      // transaction; keep polling rather than concluding it never landed.
      continue;
    }

    if (!statusResult) {
      continue;
    }
    if (statusResult.err) {
      return false;
    }
    if (
      statusResult.confirmationStatus === "confirmed" ||
      statusResult.confirmationStatus === "finalized"
    ) {
      return true;
    }
  }

  return false;
}

export async function submitSignedSolanaTransactionWithFailover(
  signedBytes: Uint8Array,
  manager: SolanaProviderManager,
  reconcileOptions: ReconcileOptions = {}
): Promise<{ signature: string }> {
  try {
    // sendRawTransaction returns the transaction signature as a base58 string —
    // no manual encoding needed on the success path.
    const signature = await manager.executeWithFailover(
      (connection) =>
        connection.sendRawTransaction(signedBytes, {
          skipPreflight: true,
          maxRetries: 0,
        }),
      "write-broadcast"
    );
    return { signature };
  } catch (err) {
    // On any broadcast error - a duplicate submission (failover resends the
    // identical signed bytes and Solana dedups by signature) or a timeout where
    // the RPC accepted the tx but never returned a response - reconcile by
    // deriving the deterministic signature from the signed bytes and checking
    // its on-chain status. Only report success for a confirmed/finalized tx
    // with NO execution error; otherwise rethrow the original error so a
    // genuinely-failed or never-landed broadcast surfaces to the caller.
    const firstSig = extractFirstSignature(signedBytes);
    if (!firstSig) {
      throw err;
    }
    const signature = bs58.encode(firstSig);

    if (await isSignatureConfirmed(signature, manager, reconcileOptions)) {
      return { signature };
    }
    throw err;
  }
}
