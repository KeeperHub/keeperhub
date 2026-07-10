import {
  type Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";
import type { NonceSession } from "../nonce-manager";
import {
  normalizeSolanaTransaction,
  parseComputeUnitPrice,
} from "../solana-tx-normalize";
import { submitSignedSolanaTransactionWithFailover } from "../submit-signed-solana";
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

export class SolanaChainAdapter implements ChainAdapter {
  readonly chainFamily = "solana";
  private readonly chainId: number;
  private readonly providerFactory: SolanaProviderFactory;
  private resolvedManager: SolanaProviderManager | null = null;

  constructor(chainId: number, providerFactory: SolanaProviderFactory) {
    this.chainId = chainId;
    this.providerFactory = providerFactory;
  }

  private async getManager(): Promise<SolanaProviderManager> {
    if (!this.resolvedManager) {
      this.resolvedManager = await this.providerFactory();
    }
    return this.resolvedManager;
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

    // Capture in a non-nullable local so TypeScript can narrow it inside
    // the executeWithFailover async closure (the outer guard doesn't flow in).
    const solanaSigner = options.solanaSigner;

    // Construct a real PublicKey from the duck-typed return of getPublicKey().
    // The SolanaTransactionSigner interface returns { toBase58(): string }
    // but normalizeSolanaTransaction requires the full @solana/web3.js PublicKey.
    const signerPublicKey = new PublicKey(
      (await solanaSigner.getPublicKey()).toBase58()
    );

    const manager = await this.getManager();

    return manager.executeWithFailover(async (connection) => {
      // 1. Get recent blockhash
      const { blockhash } = await connection.getLatestBlockhash("confirmed");

      // 2. Normalize: builds the Transaction/VersionedTransaction from
      //    request.data (Mode A) or request.to + request.value (Mode B)
      const normalized = normalizeSolanaTransaction(
        request.data,
        request.to,
        request.value,
        signerPublicKey,
        options.gasOverrides?.priorityFeeOverride,
        options.gasOverrides?.gasLimitOverride
      );

      // Hoist the isVersioned flag to keep all serialization, simulation,
      // and price parsing steps consistent.
      const isVersioned =
        normalized.mode === "A" && (normalized.isVersioned ?? false);

      // Ensure the transaction has the latest blockhash set before serializing/signing
      if (isVersioned) {
        (
          normalized.transaction as VersionedTransaction
        ).message.recentBlockhash = blockhash;
      } else {
        (normalized.transaction as Transaction).recentBlockhash = blockhash;
      }

      // 3. Serialize for signing
      const txToSign = normalized.transaction;
      const serialized = isVersioned
        ? (txToSign as VersionedTransaction).serialize()
        : (txToSign as Transaction).serialize({ requireAllSignatures: false });

      // 4. Sign via solanaSigner (Turnkey or keypair)
      const signedBytes = await solanaSigner.signTransaction(
        new Uint8Array(serialized)
      );

      // 5. Deserialize type-correctly according to isVersioned
      const signedTx = isVersioned
        ? VersionedTransaction.deserialize(signedBytes)
        : Transaction.from(signedBytes);

      // 6. Simulate before broadcast
      // Pass signature verification options to avoid redundant checking overhead
      // and match the original PR 2a specification.
      const simResult = isVersioned
        ? await connection.simulateTransaction(
            signedTx as VersionedTransaction,
            {
              sigVerify: false,
              replaceRecentBlockhash: false,
            }
          )
        : await connection.simulateTransaction(
            signedTx as Transaction,
            undefined,
            false
          );

      if (simResult.value.err) {
        throw new Error(
          `[SolanaChainAdapter] Simulation failed: ${JSON.stringify(simResult.value.err)}`
        );
      }

      // 7. Broadcast with failover + duplicate reconciliation
      const { signature } = await submitSignedSolanaTransactionWithFailover(
        signedBytes,
        manager
      );

      // 8. Wait for on-chain confirmation, then fetch receipt fields.
      // getTransaction without a prior confirm often returns null on devnet
      // because the node hasn't yet processed the tx at confirmed commitment.
      const { blockhash: latestBlockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash,
          lastValidBlockHeight,
        },
        "confirmed"
      );

      const txResult = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

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
      };
    });
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
    _rpcManager: RpcProviderManager,
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
    operation: (connection: Connection) => Promise<T>
  ): Promise<T> {
    const manager = await this.getManager();
    return manager.executeWithFailover(operation);
  }

  getTransactionUrl(txHash: string): Promise<string> {
    return Promise.resolve(buildChainTransactionUrl(this.chainId, txHash));
  }

  getAddressUrl(address: string): Promise<string> {
    return Promise.resolve(buildChainAddressUrl(this.chainId, address));
  }
}
