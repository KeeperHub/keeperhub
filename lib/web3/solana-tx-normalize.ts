import "server-only";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ErrorCategory, logDebug, logUserError } from "@/lib/logging";

export type NormalizedTxResult =
  | {
      mode: "B";
      transaction: Transaction;
    }
  | {
      mode: "A";
      transaction: Transaction | VersionedTransaction;
      isVersioned: boolean;
    };

/**
 * Normalizes input requests into deserialized Transaction or VersionedTransaction instances,
 * applying fee overrides, deduplication rules, validations, and fee payer overrides.
 */
export function normalizeSolanaTransaction(
  data: string | undefined,
  to: string,
  value: bigint | undefined,
  signerPublicKey: PublicKey,
  priorityFeeOverride?: bigint,
  gasLimitOverride?: bigint
): NormalizedTxResult {
  const trimmed = data?.trim();

  // Mode B: Native Transfer
  if (trimmed === undefined || trimmed === "") {
    if (!to) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Solana Normalizer] Recipient 'to' address is required for native transfer"
      );
      throw new Error("Recipient 'to' address is required for native transfer");
    }

    let toPubkey: PublicKey;
    try {
      toPubkey = new PublicKey(to);
    } catch (_err) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Solana Normalizer] Invalid recipient 'to' address"
      );
      throw new Error(`Invalid recipient 'to' address: ${to}`);
    }

    const valueLamports = value ?? BigInt(0);
    if (valueLamports < BigInt(0)) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Solana Normalizer] Transfer value cannot be negative"
      );
      throw new Error("Transfer value cannot be negative");
    }

    const tx = new Transaction();

    // Apply budget instructions first if overrides are provided
    if (priorityFeeOverride !== undefined) {
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeOverride,
        })
      );
    }
    if (gasLimitOverride !== undefined) {
      validateGasLimit(gasLimitOverride);
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: Number(gasLimitOverride),
        })
      );
    }

    tx.add(
      SystemProgram.transfer({
        fromPubkey: signerPublicKey,
        toPubkey,
        lamports: valueLamports,
      })
    );

    tx.feePayer = signerPublicKey;
    return { mode: "B", transaction: tx };
  }

  // Mode A: Data Present (prebuilt transaction)
  let buffer: Buffer;
  try {
    if (trimmed.startsWith("0x")) {
      buffer = Buffer.from(trimmed.slice(2), "hex");
    } else {
      buffer = Buffer.from(trimmed, "base64");
    }
  } catch (_err) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Solana Normalizer] Failed to decode transaction payload"
    );
    throw new Error(
      "Failed to decode transaction payload. Must be base64 or hex."
    );
  }

  let transaction: Transaction | VersionedTransaction;
  let isVersioned = false;

  try {
    // Attempt VersionedTransaction deserialize first
    transaction = VersionedTransaction.deserialize(buffer);
    isVersioned = true;
  } catch {
    try {
      transaction = Transaction.from(buffer);
      isVersioned = false;
    } catch (_err) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Solana Normalizer] Failed to parse transaction bytes"
      );
      throw new Error(
        "Failed to parse transaction bytes as VersionedTransaction or legacy Transaction"
      );
    }
  }

  // Check deduplication
  let hasComputeBudget = false;

  if (isVersioned) {
    const vTx = transaction as VersionedTransaction;
    const instructions = vTx.message.compiledInstructions;
    const staticAccountKeys = vTx.message.staticAccountKeys;
    for (const ix of instructions) {
      const programId = staticAccountKeys[ix.programIdIndex];
      if (programId?.equals(ComputeBudgetProgram.programId)) {
        hasComputeBudget = true;
        break;
      }
    }
  } else {
    const legacyTx = transaction as Transaction;
    const instructions = legacyTx.instructions;
    for (const ix of instructions) {
      if (ix.programId.equals(ComputeBudgetProgram.programId)) {
        hasComputeBudget = true;
        break;
      }
    }
  }

  if (hasComputeBudget) {
    if (priorityFeeOverride !== undefined || gasLimitOverride !== undefined) {
      logDebug(
        "[Solana Normalizer] Skipping compute budget overrides because transaction already contains budget instructions"
      );
    }
  } else if (
    priorityFeeOverride !== undefined ||
    gasLimitOverride !== undefined
  ) {
    // Inject overrides
    if (isVersioned) {
      const vTx = transaction as VersionedTransaction;
      // ALT guard
      if (
        vTx.message.addressTableLookups &&
        vTx.message.addressTableLookups.length > 0
      ) {
        logUserError(
          ErrorCategory.VALIDATION,
          "[Solana Normalizer] Overrides not supported on VersionedTransaction containing Address Lookup Tables (ALTs)"
        );
        throw new Error(
          "Overrides not supported on VersionedTransaction containing Address Lookup Tables (ALTs)"
        );
      }

      const decompiled = TransactionMessage.decompile(vTx.message);

      if (gasLimitOverride !== undefined) {
        validateGasLimit(gasLimitOverride);
        decompiled.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: Number(gasLimitOverride),
          })
        );
      }
      if (priorityFeeOverride !== undefined) {
        decompiled.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFeeOverride,
          })
        );
      }

      // Set/Overwrite Fee Payer
      decompiled.payerKey = signerPublicKey;

      const recompiled = decompiled.compileToV0Message();
      transaction = new VersionedTransaction(recompiled);
    } else {
      const legacyTx = transaction as Transaction;
      if (gasLimitOverride !== undefined) {
        validateGasLimit(gasLimitOverride);
        legacyTx.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: Number(gasLimitOverride),
          })
        );
      }
      if (priorityFeeOverride !== undefined) {
        legacyTx.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFeeOverride,
          })
        );
      }
      legacyTx.feePayer = signerPublicKey;
    }
  } else if (isVersioned) {
    // Overwrite Fee Payer if no overrides but different payer
    const vTx = transaction as VersionedTransaction;
    const payerKey = vTx.message.staticAccountKeys[0];
    if (!payerKey?.equals(signerPublicKey)) {
      if (
        vTx.message.addressTableLookups &&
        vTx.message.addressTableLookups.length > 0
      ) {
        logUserError(
          ErrorCategory.VALIDATION,
          "[Solana Normalizer] Fee payer normalization not supported on VersionedTransaction containing Address Lookup Tables (ALTs)"
        );
        throw new Error(
          "Fee payer normalization not supported on VersionedTransaction containing Address Lookup Tables (ALTs)"
        );
      }
      const decompiled = TransactionMessage.decompile(vTx.message);
      decompiled.payerKey = signerPublicKey;
      transaction = new VersionedTransaction(decompiled.compileToV0Message());
    }
  } else {
    const legacyTx = transaction as Transaction;
    legacyTx.feePayer = signerPublicKey;
  }

  return { mode: "A", transaction, isVersioned };
}

function validateGasLimit(limit: bigint) {
  if (limit < BigInt(1) || limit > BigInt(1_400_000)) {
    logUserError(
      ErrorCategory.VALIDATION,
      `[Solana Normalizer] Compute unit limit override out of bounds (1 - 1,400,000). Got: ${limit}`
    );
    throw new Error(
      `Compute unit limit override out of bounds (1 - 1,400,000). Got: ${limit}`
    );
  }
}

/**
 * Decodes the final serialized transaction to locate and extract a prepended ComputeUnitPrice.
 */
export function parseComputeUnitPrice(
  transaction: Transaction | VersionedTransaction,
  isVersioned: boolean
): bigint {
  if (isVersioned) {
    const vTx = transaction as VersionedTransaction;
    const instructions = vTx.message.compiledInstructions;
    const staticAccountKeys = vTx.message.staticAccountKeys;
    for (const ix of instructions) {
      const programId = staticAccountKeys[ix.programIdIndex];
      // Discriminator check (first byte is 3 for SetComputeUnitPrice)
      if (
        programId?.equals(ComputeBudgetProgram.programId) &&
        ix.data &&
        ix.data.length === 9 &&
        ix.data[0] === 3
      ) {
        const bufferData = Buffer.from(ix.data);
        const microLamports = bufferData.readBigUInt64LE(1);
        return BigInt(microLamports);
      }
    }
  } else {
    const legacyTx = transaction as Transaction;
    const instructions = legacyTx.instructions;
    for (const ix of instructions) {
      if (
        ix.programId.equals(ComputeBudgetProgram.programId) &&
        ix.data &&
        ix.data.length === 9 &&
        ix.data[0] === 3
      ) {
        const bufferData = Buffer.from(ix.data);
        const microLamports = bufferData.readBigUInt64LE(1);
        return BigInt(microLamports);
      }
    }
  }

  return BigInt(0);
}
