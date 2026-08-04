import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { NonceSession } from "../nonce-manager";

export type TransactionReceipt = {
  hash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
  /**
   * The fee the chain actually charged, in native base units. Solana reports
   * this on the confirmed transaction; an EVM fee is exactly
   * gasUsed x effectiveGasPrice, so adapters there leave it unset.
   */
  feeLamports?: bigint;
};

export type GasOverrides = {
  multiplierOverride?: number;
  gasLimitOverride?: bigint;
  // Caller-supplied maxPriorityFeePerGas (in wei). When set, the gas strategy
  // skips its chain min/max priority-fee clamp and uses this value directly.
  priorityFeeOverride?: bigint;
};

export type SendTransactionRequest = {
  to: string;
  value?: bigint;
  data?: string;
};

export type ContractCallRequest = {
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  value?: bigint;
};

export type ReadContractRequest = {
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  isView: boolean;
};

export interface ChainAdapter {
  readonly chainFamily: string;

  // ---- Write operations ----

  sendTransaction(
    signer: ethers.Signer,
    request: SendTransactionRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt>;

  executeContractCall(
    signer: ethers.Signer,
    request: ContractCallRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt>;

  // ---- Read operations ----

  readContract(
    rpcManager: RpcProviderManager,
    request: ReadContractRequest
  ): Promise<unknown>;

  // rpcManager is optional: Solana adapters own their provider manager and
  // ignore it, so Solana callers pass undefined. EVM adapters require it.
  getBalance(
    rpcManager: RpcProviderManager | undefined,
    address: string
  ): Promise<bigint>;

  executeWithFailover<T>(
    rpcManager: RpcProviderManager,
    operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
    operationType?: "read" | "write"
  ): Promise<T>;

  // ---- Explorer ----

  getTransactionUrl(txHash: string): Promise<string>;

  getAddressUrl(address: string): Promise<string>;
}

export interface SolanaTransactionSigner {
  getPublicKey(): Promise<{ toBase58(): string }>;
  signTransaction(unsignedBytes: Uint8Array): Promise<Uint8Array>;
}

export type TransactionOptions = {
  gasOverrides: GasOverrides;
  workflowId?: string;
  rpcManager?: RpcProviderManager;
  solanaSigner?: SolanaTransactionSigner;
  /** Declared max native SOL outflow (lamports) for arbitrary instruction txs. */
  maxSolLamports?: bigint;
};
