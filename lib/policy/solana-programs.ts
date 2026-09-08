import { Transaction, VersionedTransaction } from "@solana/web3.js";

/**
 * The programs a serialized Solana transaction invokes.
 *
 * A Solana signer is handed bytes rather than a target and calldata, so the
 * addresses a rule names have to be read back out of the message. Without this
 * the Solana path is unguarded: an organization can deny a program and it will
 * still be invoked, because nothing on that path ever saw an address.
 *
 * Returns an empty list when the bytes cannot be read. The caller treats that
 * as a transaction it cannot describe rather than as one that invokes nothing,
 * so a deny still fires.
 */
export function programsInvoked(bytes: Uint8Array): string[] {
  const versioned = readVersioned(bytes);
  if (versioned) {
    return versioned;
  }
  return readLegacy(bytes);
}

function readVersioned(bytes: Uint8Array): string[] | null {
  try {
    const tx = VersionedTransaction.deserialize(bytes);
    const keys = tx.message.staticAccountKeys;
    return unique(
      tx.message.compiledInstructions.map((instruction) =>
        keys[instruction.programIdIndex]?.toBase58()
      )
    );
  } catch {
    return null;
  }
}

function readLegacy(bytes: Uint8Array): string[] {
  try {
    const tx = Transaction.from(Buffer.from(bytes));
    return unique(
      tx.instructions.map((instruction) => instruction.programId.toBase58())
    );
  } catch {
    return [];
  }
}

function unique(values: (string | undefined)[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string")
    ),
  ];
}
