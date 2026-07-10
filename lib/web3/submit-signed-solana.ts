import "server-only";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";

const DUPLICATE_TX_PATTERNS = [
  "already been processed",
  "already processed",
  "duplicate",
  "This transaction has already been processed",
];

export async function submitSignedSolanaTransactionWithFailover(
  signedBytes: Uint8Array,
  manager: SolanaProviderManager
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
    const errMsg = err instanceof Error ? err.message : String(err);
    const isDuplicate = DUPLICATE_TX_PATTERNS.some((pattern) =>
      errMsg.includes(pattern)
    );

    if (isDuplicate) {
      // Decode the signature from the bytes to reconcile via getSignatureStatuses.
      const transaction = VersionedTransaction.deserialize(signedBytes);
      const firstSig = transaction.signatures[0];
      if (!firstSig) {
        throw new Error("No signatures found in signedBytes");
      }
      const signature = bs58.encode(firstSig);

      const statusResult = await manager.executeWithFailover(
        async (connection) => {
          const res = await connection.getSignatureStatuses([signature]);
          return res.value[0];
        },
        "read"
      );

      if (statusResult) {
        if (
          statusResult.confirmationStatus === "confirmed" ||
          statusResult.confirmationStatus === "finalized" ||
          !statusResult.err
        ) {
          return { signature };
        }
      }
    }
    throw err;
  }
}

