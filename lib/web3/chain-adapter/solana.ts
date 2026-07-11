import {
  type Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { RpcOperationType } from "@/lib/rpc/providers/index";
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

    const { blockhash, lastValidBlockHeight } =
      await this.executeWithSolanaFailover(
        (connection) => connection.getLatestBlockhash("confirmed"),
        "read"
      );

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
        blockhash;
    } else {
      (normalized.transaction as Transaction).recentBlockhash = blockhash;
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
    }, "preflight");

    const manager = await this.getManager();
    const { signature } = await submitSignedSolanaTransactionWithFailover(
      signedBytes,
      manager
    );

    const txResult = await this.executeWithSolanaFailover(
      async (connection) => {
        await connection.confirmTransaction(
          {
            signature,
            blockhash, // Original blockhash used for signing
            lastValidBlockHeight,
          },
          "confirmed"
        );

        return connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      },
      "read"
    );

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
    operation: (connection: Connection) => Promise<T>,
    operationType?: RpcOperationType
  ): Promise<T> {
    const manager = await this.getManager();
    return manager.executeWithFailover(operation, operationType);
  }

  getTransactionUrl(txHash: string): Promise<string> {
    return Promise.resolve(buildChainTransactionUrl(this.chainId, txHash));
  }

  getAddressUrl(address: string): Promise<string> {
    return Promise.resolve(buildChainAddressUrl(this.chainId, address));
  }
}
