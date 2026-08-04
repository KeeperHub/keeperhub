import "server-only";

import {
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { ethers } from "ethers";
import type { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import type { NonceSession } from "@/lib/web3/nonce-manager";

/**
 * Serializing a legacy Transaction requires a recentBlockhash and a feePayer or
 * serialize() throws. SolanaChainAdapter.sendTransaction overwrites the
 * blockhash with a freshly fetched one before signing, so this placeholder never
 * reaches the signer or the chain. PublicKey.default is 32 zero bytes, which is
 * valid base58 and satisfies the serializer. Kept here so every instruction-based
 * Solana write action shares one definition.
 */
export const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/**
 * Builds a legacy Solana transaction from prebuilt instructions and returns it
 * base64-encoded. SolanaChainAdapter rejects executeContractCall (Solana has no
 * ABI-encoded calls), so serialized bytes in request.data are the only way onto
 * its Turnkey signing and submit/failover path. This is the shared build half of
 * that path for instruction-based actions (raw instructions, Anchor calls).
 */
export function buildSerializedSolanaInstructionTx(args: {
  feePayer: PublicKey;
  instructions: TransactionInstruction[];
}): string {
  const transaction = new Transaction();

  for (const instruction of args.instructions) {
    transaction.add(instruction);
  }

  transaction.feePayer = args.feePayer;
  transaction.recentBlockhash = PLACEHOLDER_BLOCKHASH;

  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

export type SolanaSubmitResult = {
  hash: string;
  transactionLink: string;
  computeUnitsConsumed: string;
  effectiveGasPrice: string;
};

/**
 * Submits a base64 serialized Solana transaction through the adapter's Turnkey
 * signing + submit/failover spine. gasOverrides is deliberately empty: with an
 * override set, normalizeSolanaTransaction takes its decompile/compileToV0Message
 * branch and silently rewrites the legacy transaction as v0 - a path Turnkey's
 * Solana signer has never been exercised against. Left empty, it only normalizes
 * the fee payer, which already equals the signer, so the bytes pass through
 * untouched. The `to` field is ignored on the Mode-A (data-present) path but must
 * be a valid base58 string, so the fee payer is reused.
 */
export async function submitSolanaInstructionTx(args: {
  adapter: SolanaChainAdapter;
  solanaSigner: SolanaTransactionSigner;
  feePayer: PublicKey;
  data: string;
  maxSolLamports?: bigint;
}): Promise<SolanaSubmitResult> {
  const receipt = await args.adapter.sendTransaction(
    undefined as unknown as ethers.Signer, // unused by SolanaChainAdapter
    { to: args.feePayer.toBase58(), data: args.data },
    undefined as unknown as NonceSession, // unused by SolanaChainAdapter
    {
      solanaSigner: args.solanaSigner,
      gasOverrides: {},
      maxSolLamports: args.maxSolLamports,
    }
  );

  const transactionLink = await args.adapter.getTransactionUrl(receipt.hash);

  return {
    hash: receipt.hash,
    transactionLink,
    // Mirrors the native Solana path: the lamport fee is not computed; the raw
    // compute-unit figures are returned instead.
    computeUnitsConsumed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
  };
}
