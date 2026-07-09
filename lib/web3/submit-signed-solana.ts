import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";

// Base58 alphabet used by Solana (Bitcoin variant)
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encodes a byte array to a base58 string.
 * This is a dependency-free implementation matching bs58@4 behaviour.
 */
function encodeBase58(bytes: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let str = "";
  // Leading zeros
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    str += "1";
  }
  // Encode
  for (let i = digits.length - 1; i >= 0; i--) {
    str += BASE58_ALPHABET[digits[i]!];
  }
  return str;
}

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
  // Extract signature (base58): first 64 bytes of the signatures array
  let signature: string;
  try {
    const transaction = VersionedTransaction.deserialize(signedBytes);
    const firstSig = transaction.signatures[0];
    if (!firstSig) {
      throw new Error("No signatures found in signedBytes");
    }
    // Signatures are 64 bytes; encode to base58
    signature = encodeBase58(firstSig);
  } catch (err) {
    throw new Error(
      `Failed to extract signature from signedBytes: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await manager.executeWithFailover(async (connection) => {
      await connection.sendRawTransaction(signedBytes, {
        skipPreflight: true,
        maxRetries: 0,
      });
    }, "write-broadcast");

    return { signature };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isDuplicate = DUPLICATE_TX_PATTERNS.some((pattern) =>
      errMsg.includes(pattern)
    );

    if (isDuplicate) {
      // Reconcile via getSignatureStatuses
      const statusResult = await manager.executeWithFailover(
        async (connection) => {
          const res = await connection.getSignatureStatuses([signature]);
          return res.value[0];
        },
        "read"
      );

      if (statusResult) {
        // If confirmed/finalized or processed without errors, treat as success
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
