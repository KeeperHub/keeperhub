/**
 * Transaction Manager for KeeperHub Web3 Operations
 *
 * High-level wrapper that coordinates nonce management and gas strategy
 * with transaction execution. Provides a simple interface for workflow
 * steps to execute transactions with proper nonce handling and adaptive
 * gas estimation.
 *
 * submitAndConfirm / submitContractCallAndConfirm / executeTransaction /
 * executeContractTransaction all route the broadcast through
 * submitSignedTransactionWithFailover (sign once, broadcast same bytes
 * across the RPC failover loop, reconcile on error via on-chain lookup).
 *
 * @see docs/keeperhub/KEEP-1240/nonce.md for nonce specification
 * @see docs/keeperhub/KEEP-1240/gas.md for gas strategy specification
 */

import { eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError, logWarn } from "@/lib/logging";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { initializeWalletSigner } from "@/lib/web3/wallet-helpers";
import { getGasStrategy } from "./gas-strategy";
import { getNonceManager, type NonceSession } from "./nonce-manager";
import { OnChainRevertError } from "./onchain-revert";
import {
  type BroadcastResult,
  submitSignedTransactionWithFailover,
} from "./submit-signed";

export type TransactionContext = {
  organizationId: string;
  executionId: string;
  workflowId?: string;
  chainId: number;
  rpcUrl: string;
  rpcManager: RpcProviderManager;
};

export type TransactionResult = {
  success: boolean;
  txHash?: string;
  receipt?: ethers.TransactionReceipt;
  error?: string;
  nonce?: number;
};

export type SubmitAndConfirmOptions = {
  rpcManager: RpcProviderManager;
  session: NonceSession;
  nonce: number;
  workflowId?: string;
  chainId: number;
  maxFeePerGas: bigint;
};

export type SubmitAndConfirmResult = {
  txHash: string;
  receipt: ethers.TransactionReceipt;
  gasCostWei: string;
  transactionLink: string;
};

/**
 * Send a signer-based transaction with sign-once + failover broadcast,
 * then record -> wait -> confirm -> explorer link.
 */
export async function submitAndConfirm(
  signer: ReturnType<typeof initializeWalletSigner> extends Promise<infer T>
    ? T
    : never,
  txRequest: ethers.TransactionRequest,
  options: SubmitAndConfirmOptions
): Promise<SubmitAndConfirmResult> {
  const broadcast = await submitSignedTransactionWithFailover(
    signer,
    txRequest,
    options.rpcManager
  );
  return await confirmAndBuildResult(broadcast, options);
}

/**
 * Send a contract method call with sign-once + failover broadcast.
 * Builds calldata once, then routes through the same helper as submitAndConfirm.
 */
export async function submitContractCallAndConfirm(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  overrides: ethers.TransactionRequest,
  signer: ReturnType<typeof initializeWalletSigner> extends Promise<infer T>
    ? T
    : never,
  options: SubmitAndConfirmOptions
): Promise<SubmitAndConfirmResult> {
  const data = contract.interface.encodeFunctionData(method, args);
  const to = await contract.getAddress();
  const txRequest: ethers.TransactionRequest = {
    ...overrides,
    to,
    data,
  };
  return await submitAndConfirm(signer, txRequest, options);
}

/**
 * Shared post-broadcast flow: record pending tx, wait for mining (with
 * failover), confirm, compute gas cost, and build explorer link. Skips
 * waitForTransaction when broadcast reconciliation already returned a receipt.
 */
async function confirmAndBuildResult(
  broadcast: BroadcastResult,
  options: SubmitAndConfirmOptions
): Promise<SubmitAndConfirmResult> {
  const { rpcManager, session, nonce, workflowId, chainId, maxFeePerGas } =
    options;
  const nonceManager = getNonceManager();

  await nonceManager.recordTransaction(
    session,
    nonce,
    broadcast.hash,
    workflowId,
    maxFeePerGas.toString()
  );

  const receipt =
    broadcast.preExistingReceipt ??
    (await rpcManager.executeWithFailover(
      (provider) => provider.waitForTransaction(broadcast.hash),
      "read"
    ));

  if (!receipt) {
    throw new Error("Transaction sent but receipt not available");
  }
  throwIfReverted(receipt);

  await nonceManager.confirmTransaction(broadcast.hash);

  const gasCostWei = (receipt.gasUsed * receipt.gasPrice).toString();

  const explorerConfig = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });
  const transactionLink = explorerConfig
    ? getTransactionUrl(explorerConfig, receipt.hash)
    : "";

  return {
    txHash: receipt.hash,
    receipt,
    gasCostWei,
    transactionLink,
  };
}

// ---------------------------------------------------------------------------
// High-level helpers used by Safe deployment and roles-orchestrator
// ---------------------------------------------------------------------------

/**
 * `waitForTransaction` resolves a mined receipt whatever its status, so a
 * reverted transaction (status 0) has to become a failure here or the caller
 * reads it as `success: true`.
 */
function throwIfReverted(receipt: ethers.TransactionReceipt | null): void {
  if (receipt?.status === 0) {
    throw new OnChainRevertError({
      message: `Transaction ${receipt.hash} reverted on-chain (status 0, block ${receipt.blockNumber})`,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  }
}

/**
 * Execute a single transaction with nonce management and gas strategy.
 */
export async function executeTransaction(
  context: TransactionContext,
  walletAddress: string,
  buildTx: (nonce: number) => ethers.TransactionRequest,
  session: NonceSession
): Promise<TransactionResult> {
  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const nonce = nonceManager.getNextNonce(session);

  try {
    const baseTx = buildTx(nonce);

    const signer = await initializeWalletSigner(
      context.organizationId,
      context.rpcUrl,
      context.chainId
    );
    const provider = signer.provider;

    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const estimatedGas = await context.rpcManager.executeWithFailover(
      (rpcProvider) =>
        rpcProvider.estimateGas({ ...baseTx, from: walletAddress }),
      "preflight"
    );

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      context.chainId,
      undefined,
      undefined,
      context.rpcManager
    );

    const txRequest: ethers.TransactionRequest = {
      ...baseTx,
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
      chainId: context.chainId,
    };

    const broadcast = await submitSignedTransactionWithFailover(
      signer,
      txRequest,
      context.rpcManager
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      context.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt =
      broadcast.preExistingReceipt ??
      (await context.rpcManager.executeWithFailover(
        (rpcProvider) => rpcProvider.waitForTransaction(broadcast.hash),
        "read"
      ));
    if (!receipt) {
      throw new Error("Transaction sent but receipt not available");
    }
    throwIfReverted(receipt);

    await nonceManager.confirmTransaction(broadcast.hash);

    return {
      success: true,
      txHash: broadcast.hash,
      receipt: receipt ?? undefined,
      nonce,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      `[TransactionManager] Transaction failed at nonce=${nonce}`,
      error,
      {
        chain_id: context.chainId.toString(),
      }
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      nonce,
    };
  }
}

/**
 * Execute a transaction via contract method call with nonce management and gas strategy.
 */
export async function executeContractTransaction(
  context: TransactionContext,
  walletAddress: string,
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  session: NonceSession
): Promise<TransactionResult> {
  const nonceManager = getNonceManager();
  const gasStrategy = getGasStrategy();

  const nonce = nonceManager.getNextNonce(session);

  try {
    const provider = contract.runner?.provider;
    if (!provider) {
      throw new Error("Contract has no provider");
    }
    const signer = contract.runner as ethers.Signer;
    if (typeof signer.signTransaction !== "function") {
      throw new Error("Contract runner is not a signer");
    }

    const estimatedGas = await context.rpcManager.executeWithFailover(
      (rpcProvider) =>
        (contract.connect(rpcProvider) as typeof contract)
          .getFunction(method)
          .estimateGas(...args, { from: walletAddress }),
      "preflight"
    );

    const gasConfig = await gasStrategy.getGasConfig(
      provider as ethers.Provider,
      estimatedGas,
      context.chainId,
      undefined,
      undefined,
      context.rpcManager
    );

    const data = contract.interface.encodeFunctionData(method, args);
    const to = await contract.getAddress();
    const txRequest: ethers.TransactionRequest = {
      to,
      data,
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
      chainId: context.chainId,
    };

    const broadcast = await submitSignedTransactionWithFailover(
      signer,
      txRequest,
      context.rpcManager
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      context.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt =
      broadcast.preExistingReceipt ??
      (await context.rpcManager.executeWithFailover(
        (rpcProvider) => rpcProvider.waitForTransaction(broadcast.hash),
        "read"
      ));
    if (!receipt) {
      throw new Error("Contract transaction sent but receipt not available");
    }
    throwIfReverted(receipt);

    await nonceManager.confirmTransaction(broadcast.hash);

    return {
      success: true,
      txHash: broadcast.hash,
      receipt: receipt ?? undefined,
      nonce,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      `[TransactionManager] Contract transaction failed: method=${method} nonce=${nonce}`,
      error,
      {
        chain_id: context.chainId.toString(),
      }
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      nonce,
    };
  }
}

/**
 * Wrapper for workflow execution with nonce session management.
 * Handles session lifecycle (start, execute, end) automatically.
 */
export async function withNonceSession<T>(
  context: TransactionContext,
  walletAddress: string,
  fn: (session: NonceSession) => Promise<T>
): Promise<T> {
  const nonceManager = getNonceManager();

  const { session, validation } = await nonceManager.startSession(
    walletAddress,
    context.chainId,
    context.executionId,
    context.rpcManager
  );

  if (!validation.valid) {
    logWarn("[TransactionManager] Starting workflow with warnings", {
      warnings: validation.warnings.join("; "),
    });
  }

  try {
    return await fn(session);
  } finally {
    await nonceManager.endSession(session);
  }
}

/**
 * Get the current nonce from the chain for a wallet.
 * Useful for checking state without acquiring a lock.
 */
export async function getCurrentNonce(
  walletAddress: string,
  rpcUrl: string,
  chainId: number
): Promise<number> {
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  return await rpcManager.executeWithFailover(
    (provider) => provider.getTransactionCount(walletAddress, "pending"),
    "read"
  );
}
