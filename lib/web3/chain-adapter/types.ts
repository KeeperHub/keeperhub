import type { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { SendReport } from "@/lib/web3/submit-signed";
import type {
  NextBlockSimulation,
  NextBlockSimulationOptions,
} from "../next-block-simulation";
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
  // Set when the pre-send check and gas estimate ran against the next block.
  simulation?: NextBlockSimulation;
};

export type GasOverrides = {
  multiplierOverride?: number;
  gasLimitOverride?: bigint;
  // Caller-supplied maxPriorityFeePerGas (in wei). When set, the gas strategy
  // skips its chain min/max priority-fee clamp and uses this value directly.
  priorityFeeOverride?: bigint;
  // Caller-supplied maxFeePerGas ceiling (in wei). The strategy's fees are
  // lowered to it when they exceed it.
  maxFeeOverride?: bigint;
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
  // The `from` of the eth_call. Some contracts answer differently depending on
  // who asks: OptimismPortal2 reveals a failing withdrawal target only to
  // address(1), and a toll-gated Chronicle feed reads only for an authed
  // caller. Unset means no overrides object is built at all, so the call is
  // the one this made before the field existed.
  callerAddress?: string;
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
  // EVM only: filled with the send route and whether a receipt came back.
  sendReport?: SendReport;
  solanaSigner?: SolanaTransactionSigner;
  /** Declared max native SOL outflow (lamports) for arbitrary instruction txs. */
  maxSolLamports?: bigint;
  /** Present = simulate and estimate gas as of the next block (EVM only). */
  simulation?: NextBlockSimulationOptions;
};
