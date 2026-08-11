import "server-only";

import { ethers } from "ethers";
import { startSafeTxMetrics } from "@/lib/metrics/instrumentation/safe";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { buildExecTransactionCalldata } from "@/lib/safe/allowance-module";
import { buildExecTransactionWithRoleCalldata } from "@/lib/safe/zodiac-roles";
import type { TransactionReceipt } from "@/lib/web3/chain-adapter/types";
import { getGasStrategy } from "@/lib/web3/gas-strategy";
import { getNonceManager, type NonceSession } from "@/lib/web3/nonce-manager";
import {
  NonceConflictError,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

/**
 * Execute an arbitrary contract call from a deployed Safe's perspective.
 *
 * Given the inner target (contractAddress + ABI + functionKey + args + value),
 * builds `safe.execTransaction(innerTarget, value, innerCalldata, ...)` and
 * submits it with the Turnkey EOA as the signer. On-chain `msg.sender` at
 * the target becomes the Safe's address; funds for the inner call are drawn
 * from the Safe's balance, not the EOA's.
 *
 * Gas is still paid by the outer signer (Turnkey EOA) and the nonce advances
 * on the EOA. The Safe itself has no nonce from the EOA's perspective.
 */
export type ExecuteAsSafeRequest = {
  safeAddress: string;
  ownerAddress: string;
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  value?: bigint;
};

export type ExecuteAsSafeOptions = {
  chainId: number;
  workflowId?: string;
  rpcManager: RpcProviderManager;
};

/**
 * Classify the inner call so the safe.tx.* metric distinguishes ERC-20
 * transfers/approvals from arbitrary contract calls. The detection is
 * a literal function-name match; anything else is "contract".
 */
function classifyInnerKind(
  functionKey: string,
  value: bigint | undefined
): "native" | "erc20" | "contract" {
  if (functionKey === "transfer" || functionKey === "approve") {
    return "erc20";
  }
  if ((value ?? BigInt(0)) > BigInt(0)) {
    return "native";
  }
  return "contract";
}

function finishOnError(
  finishMetrics: (outcome: "success" | "failure" | "nonce-conflict") => void,
  err: unknown
): never {
  finishMetrics(
    err instanceof NonceConflictError ? "nonce-conflict" : "failure"
  );
  throw err;
}

export async function executeContractCallAsSafe(
  signer: ethers.Signer,
  request: ExecuteAsSafeRequest,
  session: NonceSession,
  options: ExecuteAsSafeOptions
): Promise<TransactionReceipt> {
  const finishMetrics = startSafeTxMetrics({
    chainId: options.chainId,
    route: "exec",
    kind: classifyInnerKind(request.functionKey, request.value),
  });
  try {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const contractInterface = new ethers.Interface(request.abi);
    const innerCalldata = contractInterface.encodeFunctionData(
      request.functionKey,
      request.args
    );

    const outerCalldata = buildExecTransactionCalldata({
      to: request.contractAddress,
      data: innerCalldata,
      value: request.value ?? BigInt(0),
      ownerAddress: request.ownerAddress,
    });

    const nonceManager = getNonceManager();
    const gasStrategy = getGasStrategy();

    const estimatedGas = await options.rpcManager.executeWithFailover(
      (rpcProvider) =>
        rpcProvider.estimateGas({
          to: request.safeAddress,
          data: outerCalldata,
          from: request.ownerAddress,
        }),
      "preflight"
    );

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      options.chainId,
      undefined,
      undefined,
      options.rpcManager
    );

    const nonce = nonceManager.getNextNonce(session);

    const broadcast = await submitSignedTransactionWithFailover(
      signer,
      {
        to: request.safeAddress,
        data: outerCalldata,
        value: BigInt(0),
        nonce,
        gasLimit: gasConfig.gasLimit,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        chainId: options.chainId,
      },
      options.rpcManager
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt =
      broadcast.preExistingReceipt ??
      (await options.rpcManager.executeWithFailover(
        (p) => p.waitForTransaction(broadcast.hash),
        "read"
      ));
    if (!receipt) {
      throw new Error("Safe-routed transaction sent but receipt unavailable");
    }

    await nonceManager.confirmTransaction(broadcast.hash);
    finishMetrics("success");
    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
    };
  } catch (err) {
    finishOnError(finishMetrics, err);
  }
}

// ---------------------------------------------------------------------------
// Role-routed variants -- used when a Zodiac Roles Modifier is installed on
// the Safe and the signer-resolver returns kind === "safe-role".
//
// The delegate (same Turnkey EOA in MVP) sends directly to the modifier
// (NOT through the Safe). The modifier validates target + function + params
// against the role, then calls back into the Safe via
// `execTransactionFromModule`. msg.sender at the target still resolves to
// the Safe address.
// ---------------------------------------------------------------------------

export type ExecuteAsRoleRequest = {
  safeAddress: string;
  /** Delegate EOA authorised to use the role (our Turnkey EOA) */
  delegateAddress: string;
  /** Proxied Roles Modifier address deployed per-Safe */
  rolesModifierAddress: string;
  /** bytes32 role key */
  roleKey: string;
  contractAddress: string;
  abi: ethers.InterfaceAbi;
  functionKey: string;
  args: unknown[];
  value?: bigint;
};

export async function executeContractCallAsRole(
  signer: ethers.Signer,
  request: ExecuteAsRoleRequest,
  session: NonceSession,
  options: ExecuteAsSafeOptions
): Promise<TransactionReceipt> {
  const finishMetrics = startSafeTxMetrics({
    chainId: options.chainId,
    route: "role",
    kind: classifyInnerKind(request.functionKey, request.value),
  });
  try {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const contractInterface = new ethers.Interface(request.abi);
    const innerCalldata = contractInterface.encodeFunctionData(
      request.functionKey,
      request.args
    );

    const outerCalldata = buildExecTransactionWithRoleCalldata({
      to: request.contractAddress,
      value: request.value ?? BigInt(0),
      data: innerCalldata,
      operation: 0,
      roleKey: request.roleKey,
      shouldRevert: true,
    });

    const nonceManager = getNonceManager();
    const gasStrategy = getGasStrategy();

    const estimatedGas = await options.rpcManager.executeWithFailover(
      (rpcProvider) =>
        rpcProvider.estimateGas({
          to: request.rolesModifierAddress,
          data: outerCalldata,
          from: request.delegateAddress,
        }),
      "preflight"
    );

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      options.chainId,
      undefined,
      undefined,
      options.rpcManager
    );

    const nonce = nonceManager.getNextNonce(session);

    const broadcast = await submitSignedTransactionWithFailover(
      signer,
      {
        to: request.rolesModifierAddress,
        data: outerCalldata,
        value: BigInt(0),
        nonce,
        gasLimit: gasConfig.gasLimit,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        chainId: options.chainId,
      },
      options.rpcManager
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt =
      broadcast.preExistingReceipt ??
      (await options.rpcManager.executeWithFailover(
        (p) => p.waitForTransaction(broadcast.hash),
        "read"
      ));
    if (!receipt) {
      throw new Error("Role-routed transaction sent but receipt unavailable");
    }
    await nonceManager.confirmTransaction(broadcast.hash);
    finishMetrics("success");
    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
    };
  } catch (err) {
    finishOnError(finishMetrics, err);
  }
}

export type ExecuteNativeAsRoleRequest = {
  safeAddress: string;
  delegateAddress: string;
  rolesModifierAddress: string;
  roleKey: string;
  to: string;
  amount: bigint;
};

export async function executeNativeTransferAsRole(
  signer: ethers.Signer,
  request: ExecuteNativeAsRoleRequest,
  session: NonceSession,
  options: ExecuteAsSafeOptions
): Promise<TransactionReceipt> {
  const finishMetrics = startSafeTxMetrics({
    chainId: options.chainId,
    route: "role",
    kind: "native",
  });
  try {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const outerCalldata = buildExecTransactionWithRoleCalldata({
      to: request.to,
      value: request.amount,
      data: "0x",
      operation: 0,
      roleKey: request.roleKey,
      shouldRevert: true,
    });

    const nonceManager = getNonceManager();
    const gasStrategy = getGasStrategy();

    const estimatedGas = await options.rpcManager.executeWithFailover(
      (rpcProvider) =>
        rpcProvider.estimateGas({
          to: request.rolesModifierAddress,
          data: outerCalldata,
          from: request.delegateAddress,
        }),
      "preflight"
    );

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      options.chainId,
      undefined,
      undefined,
      options.rpcManager
    );

    const nonce = nonceManager.getNextNonce(session);

    const broadcast = await submitSignedTransactionWithFailover(
      signer,
      {
        to: request.rolesModifierAddress,
        data: outerCalldata,
        value: BigInt(0),
        nonce,
        gasLimit: gasConfig.gasLimit,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        chainId: options.chainId,
      },
      options.rpcManager
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt =
      broadcast.preExistingReceipt ??
      (await options.rpcManager.executeWithFailover(
        (p) => p.waitForTransaction(broadcast.hash),
        "read"
      ));
    if (!receipt) {
      throw new Error(
        "Role-routed native transfer sent but receipt unavailable"
      );
    }
    await nonceManager.confirmTransaction(broadcast.hash);
    finishMetrics("success");
    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
    };
  } catch (err) {
    finishOnError(finishMetrics, err);
  }
}

/**
 * Execute a native value transfer from the Safe. Wraps a zero-data call
 * through `safe.execTransaction` -- the Safe sends `amount` to `to` from
 * its own balance, and the Turnkey EOA signs the outer tx.
 */
export type ExecuteNativeAsSafeRequest = {
  safeAddress: string;
  ownerAddress: string;
  to: string;
  amount: bigint;
};

export async function executeNativeTransferAsSafe(
  signer: ethers.Signer,
  request: ExecuteNativeAsSafeRequest,
  session: NonceSession,
  options: ExecuteAsSafeOptions
): Promise<TransactionReceipt> {
  const finishMetrics = startSafeTxMetrics({
    chainId: options.chainId,
    route: "exec",
    kind: "native",
  });
  try {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const outerCalldata = buildExecTransactionCalldata({
      to: request.to,
      data: "0x",
      value: request.amount,
      ownerAddress: request.ownerAddress,
    });

    const nonceManager = getNonceManager();
    const gasStrategy = getGasStrategy();

    const estimatedGas = await options.rpcManager.executeWithFailover(
      (rpcProvider) =>
        rpcProvider.estimateGas({
          to: request.safeAddress,
          data: outerCalldata,
          from: request.ownerAddress,
        }),
      "preflight"
    );

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      options.chainId,
      undefined,
      undefined,
      options.rpcManager
    );

    const nonce = nonceManager.getNextNonce(session);

    const broadcast = await submitSignedTransactionWithFailover(
      signer,
      {
        to: request.safeAddress,
        data: outerCalldata,
        value: BigInt(0),
        nonce,
        gasLimit: gasConfig.gasLimit,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        chainId: options.chainId,
      },
      options.rpcManager
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt =
      broadcast.preExistingReceipt ??
      (await options.rpcManager.executeWithFailover(
        (p) => p.waitForTransaction(broadcast.hash),
        "read"
      ));
    if (!receipt) {
      throw new Error(
        "Safe-routed native transfer sent but receipt unavailable"
      );
    }

    await nonceManager.confirmTransaction(broadcast.hash);
    finishMetrics("success");
    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
    };
  } catch (err) {
    finishOnError(finishMetrics, err);
  }
}
