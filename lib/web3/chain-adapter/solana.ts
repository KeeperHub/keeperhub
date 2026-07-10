import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { SolanaProviderManager } from "@/lib/rpc/providers/solana";
import type { NonceSession } from "../nonce-manager";
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

  sendTransaction(
    _signer: ethers.Signer,
    _request: SendTransactionRequest,
    _session: NonceSession,
    _options: TransactionOptions
  ): Promise<TransactionReceipt> {
    return Promise.reject(
      new Error(
        "[SolanaChainAdapter] sendTransaction is not supported on Solana chains. Deferred to PR 2."
      )
    );
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

  async getTransactionUrl(txHash: string): Promise<string> {
    return buildChainTransactionUrl(this.chainId, txHash);
  }

  async getAddressUrl(address: string): Promise<string> {
    return buildChainAddressUrl(this.chainId, address);
  }
}
