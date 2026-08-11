import {
  type Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { ethers } from "ethers";
import { logWarn } from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { RpcOperationType } from "@/lib/rpc/providers/index";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";
import { getErrorMessage } from "@/lib/utils";
import type { NonceSession } from "../nonce-manager";
import { assertMaxSolLamportsOutflow } from "../solana-max-sol-guard";
import {
  type NormalizedTxResult,
  normalizeSolanaTransaction,
  parseComputeUnitPrice,
} from "../solana-tx-normalize";
import {
  deriveSolanaSignature,
  submitSignedSolanaTransactionWithFailover,
} from "../submit-signed-solana";
import { buildChainAddressUrl, buildChainTransactionUrl } from "./explorer";
import type {
  ChainAdapter,
  ContractCallRequest,
  ReadContractRequest,
  SendTransactionRequest,
  TransactionOptions,
  TransactionReceipt,
} from "./types";

type SolanaProviderFactory = () => Promise<SolanaProviderManager>;

type SolanaBlockhashRefs = {
  blockhash: string;
  lastValidBlockHeight: number;
};

type SolanaSignedAttempt = {
  signedBytes: Uint8Array;
  signedTx: Transaction | VersionedTransaction;
  isVersioned: boolean;
  normalized: NormalizedTxResult;
  blockhashRefs: SolanaBlockhashRefs;
};

const BLOCKHASH_EXPIRY_PATTERN =
  /blockhashnotfound|block height exceeded|blockhash expired|transaction expired/i;

function isSolanaBlockhashExpiryError(error: unknown): boolean {
  return BLOCKHASH_EXPIRY_PATTERN.test(getErrorMessage(error));
}

/**
 * How long to wait for an expired-looking broadcast to resolve one way or the
 * other. A blockhash stays valid for 150 slots, so a genuinely dead transaction
 * proves itself well inside this; the bound exists so a stalled RPC cannot hang
 * an execution indefinitely.
 */
const EXPIRY_PROOF_TIMEOUT_MS = 90_000;
const EXPIRY_PROOF_POLL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Overrides for the waits on the broadcast-failure path: proving an expired
 * transaction's fate, and the signature reconcile inside submit. Exists so
 * tests need not sleep.
 */
export type SolanaExpiryProofTimings = {
  timeoutMs?: number;
  pollMs?: number;
  reconcileDelayMs?: number;
};

export class SolanaChainAdapter implements ChainAdapter {
  readonly chainFamily = "solana";
  private readonly chainId: number;
  private readonly providerFactory: SolanaProviderFactory;
  private readonly timings: SolanaExpiryProofTimings;
  private managerPromise: Promise<SolanaProviderManager> | null = null;

  constructor(
    chainId: number,
    providerFactory: SolanaProviderFactory,
    timings: SolanaExpiryProofTimings = {}
  ) {
    this.chainId = chainId;
    this.providerFactory = providerFactory;
    this.timings = timings;
  }

  private getManager(): Promise<SolanaProviderManager> {
    // Cache the in-flight promise, not the resolved value, so concurrent
    // callers share a single providerFactory() invocation. This adapter is a
    // process-lifetime singleton (see chain-adapter registry), so it serves
    // overlapping requests.
    this.managerPromise ??= this.providerFactory();
    return this.managerPromise;
  }

  private async buildSignAndSimulate(
    request: SendTransactionRequest,
    options: TransactionOptions,
    solanaSigner: NonNullable<TransactionOptions["solanaSigner"]>,
    signerPublicKey: PublicKey,
    blockhashRefs: SolanaBlockhashRefs
  ): Promise<SolanaSignedAttempt> {
    const normalized = normalizeSolanaTransaction(
      request.data,
      request.to,
      request.value,
      signerPublicKey,
      options.gasOverrides?.priorityFeeOverride,
      options.gasOverrides?.gasLimitOverride
    );

    const isVersioned =
      normalized.mode === "A" && (normalized.isVersioned ?? false);

    if (isVersioned) {
      (normalized.transaction as VersionedTransaction).message.recentBlockhash =
        blockhashRefs.blockhash;
    } else {
      (normalized.transaction as Transaction).recentBlockhash =
        blockhashRefs.blockhash;
    }

    const txToSign = normalized.transaction;
    const serialized = isVersioned
      ? (txToSign as VersionedTransaction).serialize()
      : (txToSign as Transaction).serialize({ requireAllSignatures: false });

    const signedBytes = await solanaSigner.signTransaction(
      new Uint8Array(serialized)
    );

    const signedTx = isVersioned
      ? VersionedTransaction.deserialize(signedBytes)
      : Transaction.from(signedBytes);

    await this.executeWithSolanaFailover(async (connection) => {
      const enforceMaxSol = options.maxSolLamports !== undefined;
      // Read before simulating, so a deposit landing between the two reads
      // shrinks the apparent outflow. The gap cannot be closed from here: the
      // simulation exposes only post-state, and no RPC pins a balance read to
      // the exact slot the simulation was evaluated against. It fails in the
      // permissive direction, so this ceiling is a preflight guard rather than
      // a settlement figure; the true delta is only knowable after
      // confirmation.
      const preBalance = enforceMaxSol
        ? BigInt(await connection.getBalance(signerPublicKey))
        : BigInt(0);

      // Ask for the fee payer's simulated post-state by address on both
      // branches, so the account of interest is always at index 0.
      //
      // Requesting it is not optional on the versioned branch: a legacy
      // transaction deserializes into a VersionedTransaction wrapping a legacy
      // Message rather than throwing, so every prebuilt transaction reaches
      // this branch and an omitted `accounts` config leaves the maxSol check
      // with nothing to read.
      //
      // Addressing by key also avoids indexing into the response by the
      // transaction's own account-key position, which does not line up: the
      // legacy RPC returns only nonProgramIds, not the full key list.
      const simResult = isVersioned
        ? await connection.simulateTransaction(
            signedTx as VersionedTransaction,
            {
              sigVerify: false,
              replaceRecentBlockhash: false,
              ...(enforceMaxSol
                ? {
                    accounts: {
                      encoding: "base64" as const,
                      addresses: [signerPublicKey.toBase58()],
                    },
                  }
                : {}),
            }
          )
        : await connection.simulateTransaction(
            signedTx as Transaction,
            undefined,
            enforceMaxSol ? [signerPublicKey] : undefined
          );

      if (simResult.value.err) {
        throw new Error(
          `[SolanaChainAdapter] Simulation failed: ${JSON.stringify(simResult.value.err)}`
        );
      }

      if (enforceMaxSol && options.maxSolLamports !== undefined) {
        // A fee payer absent from the transaction simulates to a null entry
        // here, which lands in the same branch as a missing account state.
        const postLamports = simResult.value.accounts?.[0]?.lamports;
        if (postLamports === undefined) {
          throw new Error(
            "[SolanaChainAdapter] Simulation did not return fee payer account state for maxSol check"
          );
        }
        const outflow =
          preBalance > BigInt(postLamports)
            ? preBalance - BigInt(postLamports)
            : BigInt(0);
        assertMaxSolLamportsOutflow({
          outflowLamports: outflow,
          maxSolLamports: options.maxSolLamports,
        });
      }
    }, "preflight");

    return {
      signedBytes,
      signedTx,
      isVersioned,
      normalized,
      blockhashRefs,
    };
  }

  /**
   * Settles the fate of a broadcast that failed with a blockhash-expiry error,
   * before its bytes are abandoned for a re-signed replacement.
   *
   * Returns the signature when the transaction did land, so the caller adopts
   * it instead of sending a second one - the post-confirmation checks then
   * report an on-chain failure normally. Returns null only once inclusion has
   * become impossible, which is the single condition that makes re-signing
   * safe: past lastValidBlockHeight the network will no longer accept that
   * blockhash, so the transaction can never appear afterwards.
   *
   * Throws if neither is established within the wait. Failing the execution is
   * the conservative outcome; re-signing on an unresolved transaction is the
   * one that can spend twice.
   */
  private async settlePriorAttempt(
    attempt: SolanaSignedAttempt,
    blockhashRefs: SolanaBlockhashRefs
  ): Promise<string | null> {
    const signature = deriveSolanaSignature(attempt.signedBytes);
    if (!signature) {
      // Unparseable bytes cannot be looked up, so nothing can be proven.
      throw new Error(
        "[SolanaChainAdapter] Cannot verify the expired transaction's fate: signature is underivable"
      );
    }

    const deadline =
      Date.now() + (this.timings.timeoutMs ?? EXPIRY_PROOF_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const { status, blockHeight } = await this.executeWithSolanaFailover(
        async (connection) => {
          const statuses = await connection.getSignatureStatuses([signature]);
          return {
            status: statuses.value[0],
            blockHeight: await connection.getBlockHeight("confirmed"),
          };
        },
        "read"
      );

      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return signature;
      }

      // Only conclusive once the chain has moved past the point where this
      // blockhash could still be accepted.
      if (blockHeight > blockhashRefs.lastValidBlockHeight) {
        return null;
      }

      await sleep(this.timings.pollMs ?? EXPIRY_PROOF_POLL_MS);
    }

    throw new Error(
      `[SolanaChainAdapter] Transaction ${signature} did not confirm and its blockhash has not expired; refusing to re-sign while it may still land`
    );
  }

  async sendTransaction(
    _signer: ethers.Signer, // Unused: Solana uses options.solanaSigner
    request: SendTransactionRequest,
    _session: NonceSession, // Unused: Solana has no EVM nonce concept
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    if (!options.solanaSigner) {
      throw new Error("[SolanaChainAdapter] Missing options.solanaSigner");
    }

    const solanaSigner = options.solanaSigner;

    const signerPublicKey = new PublicKey(
      (await solanaSigner.getPublicKey()).toBase58()
    );

    const manager = await this.getManager();
    let signedAttempt: SolanaSignedAttempt | null = null;
    let signature: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const blockhashRefs = await this.executeWithSolanaFailover(
        (connection) => connection.getLatestBlockhash("confirmed"),
        "read"
      );

      signedAttempt = await this.buildSignAndSimulate(
        request,
        options,
        solanaSigner,
        signerPublicKey,
        blockhashRefs
      );

      try {
        const submitResult = await submitSignedSolanaTransactionWithFailover(
          signedAttempt.signedBytes,
          manager,
          this.timings.reconcileDelayMs === undefined
            ? {}
            : { delayMs: this.timings.reconcileDelayMs }
        );
        signature = submitResult.signature;
        break;
      } catch (error) {
        if (attempt === 0 && isSolanaBlockhashExpiryError(error)) {
          // Retrying means re-signing against a fresh blockhash, which produces
          // a second transaction with its own signature. Solana will not dedupe
          // the two, so if the first one is still live both can land and the
          // transfer happens twice. Only retry once the first is provably dead.
          const settled = await this.settlePriorAttempt(
            signedAttempt,
            blockhashRefs
          );
          if (settled) {
            signature = settled;
            break;
          }
          continue;
        }
        throw error;
      }
    }

    if (!(signedAttempt && signature)) {
      throw new Error(
        "[SolanaChainAdapter] Failed to submit transaction after blockhash retry"
      );
    }

    const { blockhashRefs, normalized, isVersioned } = signedAttempt;

    const { confirmationErr, txResult } = await this.executeWithSolanaFailover(
      async (connection) => {
        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash: blockhashRefs.blockhash,
            lastValidBlockHeight: blockhashRefs.lastValidBlockHeight,
          },
          "confirmed"
        );

        const tx = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        return { confirmationErr: confirmation.value.err, txResult: tx };
      },
      "read"
    );

    if (confirmationErr) {
      throw new Error(
        `[SolanaChainAdapter] Transaction ${signature} failed on-chain: ${JSON.stringify(confirmationErr)}`
      );
    }
    if (txResult?.meta?.err) {
      throw new Error(
        `[SolanaChainAdapter] Transaction ${signature} reverted on-chain: ${JSON.stringify(txResult.meta.err)}`
      );
    }

    const computeUnitsConsumed =
      txResult?.meta?.computeUnitsConsumed == null
        ? BigInt(0)
        : BigInt(txResult.meta.computeUnitsConsumed);

    const effectiveGasPrice = parseComputeUnitPrice(
      normalized.transaction,
      isVersioned
    );

    return {
      hash: signature,
      gasUsed: computeUnitsConsumed,
      effectiveGasPrice,
      blockNumber: txResult?.slot ?? 0,
      // What the chain charged, rather than a figure reconstructed from the
      // compute budget. Reconstruction assumes exactly one signature, which
      // holds for every transaction this adapter signs today but is not a
      // property of the transaction the caller gets back.
      feeLamports:
        txResult?.meta?.fee == null ? undefined : BigInt(txResult.meta.fee),
    };
  }

  executeContractCall(
    _signer: ethers.Signer,
    _request: ContractCallRequest,
    _session: NonceSession,
    _options: TransactionOptions
  ): Promise<TransactionReceipt> {
    return Promise.reject(
      new Error(
        "[SolanaChainAdapter] executeContractCall is not supported on Solana. Solana programs use instruction data, not ABI-encoded calls."
      )
    );
  }

  readContract(
    _rpcManager: RpcProviderManager,
    _request: ReadContractRequest
  ): Promise<unknown> {
    return Promise.reject(
      new Error(
        "[SolanaChainAdapter] readContract is not supported on Solana. Solana does not use ABI-encoded view functions."
      )
    );
  }

  async getBalance(
    _rpcManager: RpcProviderManager | undefined,
    address: string
  ): Promise<bigint> {
    const pubkey = new PublicKey(address);
    const manager = await this.getManager();
    return manager.executeWithFailover(async (connection) => {
      const lamports = await connection.getBalance(pubkey);
      return BigInt(lamports);
    });
  }

  executeWithFailover<T>(
    _rpcManager: RpcProviderManager,
    _operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
    _operationType?: "read" | "write"
  ): Promise<T> {
    return Promise.reject(
      new Error(
        "[SolanaChainAdapter] executeWithFailover via RpcProviderManager is not supported on Solana. " +
          "Cast to SolanaChainAdapter and call executeWithSolanaFailover instead."
      )
    );
  }

  async executeWithSolanaFailover<T>(
    operation: (connection: Connection) => Promise<T>,
    operationType?: RpcOperationType
  ): Promise<T> {
    const manager = await this.getManager();
    return manager.executeWithFailover(operation, operationType);
  }

  // The explorer URL is cosmetic. A failure building it (e.g. the explorer-config
  // lookup throwing) must never propagate: by the time a transfer step calls this
  // the transaction is already on-chain, and a throw here would flip a completed
  // transfer's result to failed. Callers treat "" as "no link available".
  async getTransactionUrl(txHash: string): Promise<string> {
    try {
      return await buildChainTransactionUrl(this.chainId, txHash);
    } catch (error) {
      logWarn(
        `[SolanaChainAdapter] Failed to build transaction explorer URL: ${getErrorMessage(error)}`,
        { chain_id: String(this.chainId) }
      );
      return "";
    }
  }

  async getAddressUrl(address: string): Promise<string> {
    try {
      return await buildChainAddressUrl(this.chainId, address);
    } catch (error) {
      logWarn(
        `[SolanaChainAdapter] Failed to build address explorer URL: ${getErrorMessage(error)}`,
        { chain_id: String(this.chainId) }
      );
      return "";
    }
  }
}
