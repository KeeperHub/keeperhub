import "server-only";
import {
  type Keypair,
  type PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { SolanaTransactionSigner } from "./chain-adapter/types";

export class SolanaKeypairSigner implements SolanaTransactionSigner {
  private readonly keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  getPublicKey(): Promise<PublicKey> {
    return Promise.resolve(this.keypair.publicKey);
  }

  signTransaction(serializedTx: Uint8Array): Promise<Uint8Array> {
    let transaction: Transaction | VersionedTransaction;
    let isVersioned = false;

    try {
      transaction = VersionedTransaction.deserialize(serializedTx);
      isVersioned = true;
    } catch {
      try {
        transaction = Transaction.from(serializedTx);
        isVersioned = false;
      } catch (_err) {
        throw new Error(
          "Failed to deserialize transaction bytes in signTransaction"
        );
      }
    }

    if (isVersioned) {
      const vTx = transaction as VersionedTransaction;
      vTx.sign([this.keypair]);
      return Promise.resolve(vTx.serialize());
    }
    const legacyTx = transaction as Transaction;
    legacyTx.sign(this.keypair);
    return Promise.resolve(legacyTx.serialize());
  }
}
