import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { NonceSession } from "../nonce-manager";

export type TransactionReceipt = {
  hash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
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

  getBalance(rpcManager: RpcProviderManager, address: string): Promise<bigint>;

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
};
