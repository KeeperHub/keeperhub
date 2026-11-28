import "server-only";

import { ethers } from "ethers";
import { startSafeTxMetrics } from "@/lib/metrics/instrumentation/safe";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";
import { buildExecTransactionCalldata } from "@/lib/safe/allowance-module";
import { buildExecTransactionWithRoleCalldata } from "@/lib/safe/zodiac-roles";
import { getErrorMessage } from "@/lib/utils";
import type { TransactionReceipt } from "@/lib/web3/chain-adapter/types";
import { getGasStrategy } from "@/lib/web3/gas-strategy";
import {
  type NextBlockSimulation,
  type NextBlockSimulationOptions,
  simulateSendAtNextBlock,
  tagNextBlockSimulation,
} from "@/lib/web3/next-block-simulation";
import { getNonceManager, type NonceSession } from "@/lib/web3/nonce-manager";
import {
  minedRevertError,
  OnChainPendingError,
} from "@/lib/web3/onchain-revert";
import { pollReceipt, RECEIPT_WAIT_TIMEOUT_MS } from "@/lib/web3/receipt-wait";
import {
  type BroadcastResult,
  NonceConflictError,
  type SendReport,
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
  // Present = estimate (and so revert-check) as of the next block.
  simulation?: NextBlockSimulationOptions;
  // The node's priority fee and max fee, applied to the owner transaction.
  feeOverrides?: { priorityFeeOverride?: bigint; maxFeeOverride?: bigint };
  // Filled with the outer transaction's route and whether a receipt came back.
  sendReport?: SendReport;
};

// The outer transaction's gas estimate, which is also its revert check.
async function estimateOuterGas(
  options: ExecuteAsSafeOptions,
  tx: { to: string; data: string; from: string }
): Promise<{ gas: bigint; simulation?: NextBlockSimulation }> {
  if (!options.simulation) {
    const gas = await options.rpcManager.executeWithFailover(
      (rpcProvider) => rpcProvider.estimateGas(tx),
      "preflight"
    );
    return { gas };
  }
  const simulated = await simulateSendAtNextBlock(options.rpcManager, {
    chainId: options.chainId,
    tx,
    options: options.simulation,
  });
  return { gas: simulated.gasEstimate, simulation: simulated.simulation };
}

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

/**
 * A mined receipt with status 0 is a reverted transaction. Both Safe routes
 * are built so that an inner-call failure reverts the whole outer transaction
 * (execTransaction with safeTxGas=0 and gasPrice=0, execTransactionWithRole
 * with shouldRevert=true), and a receipt read, unlike `tx.wait()`, returns
 * that receipt instead of throwing, so the status has to be read here.
 */
function throwIfReverted(
  receipt: ethers.TransactionReceipt,
  gasLimit: bigint
): void {
  if (receipt.status === 0) {
    throw minedRevertError(receipt, gasLimit);
  }
}

/**
 * Wait for a Safe-routed transaction's receipt, keeping the hash on every way
 * the wait can end without one.
 *
 * Both failure modes here are post-broadcast: the transaction is on the
 * network and the nonce is spent. A failed receipt read and a null receipt
 * once threw bare Errors, so neither carried the hash. The finalizer
 * harvests hashes off the error, so a hash-less throw stamped a terminal
 * failure on a transaction that existed on-chain and nowhere in our data --
 * #2020, entered from the Safe path.
 *
 * Every throw becomes OnChainPendingError, not OnChainRevertError: failing to
 * READ a receipt says nothing about whether the transaction succeeded. The
 * settled-failure case is status 0, which arrives as a receipt and is
 * classified by throwIfReverted at the call sites.
 *
 * The wait polls the receipt (pollReceipt) until RECEIPT_WAIT_TIMEOUT_MS, each
 * read through the failover (on a relay, the provider that sent, each read
 * capped), so a dead endpoint costs one read, not the wait. Not ethers'
 * waitForTransaction: it swallows read errors and can leave an unhandled
 * rejection when its first read fails.
 */
async function waitForSafeReceipt(
  broadcast: BroadcastResult,
  rpcManager: RpcProviderManager,
  label: string,
  report: SendReport = {}
): Promise<ethers.TransactionReceipt> {
  const receipt =
    broadcast.preExistingReceipt ??
    (await readSafeReceipt(broadcast, rpcManager, label, report.route));
  report.included = true;
  return receipt;
}

/** Where a relay manager's send went: the relay, or the strict: false fallback. */
function relaySendProvider(
  rpcManager: RpcProviderManager,
  route: SendReport["route"]
): ethers.JsonRpcProvider {
  return (
    (route === "public" ? rpcManager.getFallbackProvider() : null) ??
    rpcManager.getProvider()
  );
}

// Between receipt reads while a Safe send waits for inclusion.
const RECEIPT_POLL_INTERVAL_MS = 2000;
// One receipt read on the relay, which has no failover to end a hung read.
const RELAY_RECEIPT_READ_TIMEOUT_MS = 30_000;

async function readSafeReceipt(
  broadcast: BroadcastResult,
  rpcManager: RpcProviderManager,
  label: string,
  route: SendReport["route"]
): Promise<ethers.TransactionReceipt> {
  const { hash } = broadcast;
  const relay = rpcManager.hasPrivateRelayPrimary();
  const read = (): Promise<ethers.TransactionReceipt | null> =>
    relay
      ? relaySendProvider(rpcManager, route).getTransactionReceipt(hash)
      : rpcManager.executeWithFailover(
          (provider) => provider.getTransactionReceipt(hash),
          "read"
        );
  // Inclusion can take minutes (a relay holds a send about 25 blocks).
  const outcome = await pollReceipt(read, {
    timeoutMs: RECEIPT_WAIT_TIMEOUT_MS,
    intervalMs: RECEIPT_POLL_INTERVAL_MS,
    // A relay read has no failover, so a hung one is cut short.
    readTimeoutMs: relay ? RELAY_RECEIPT_READ_TIMEOUT_MS : undefined,
  });
  if (outcome.receipt) {
    return outcome.receipt;
  }
  throw new OnChainPendingError({
    message: outcome.lastReadError
      ? `${label} sent but receipt could not be read (${redactAllUrls(getErrorMessage(outcome.lastReadError))})`
      : `${label} sent but not included within ${RECEIPT_WAIT_TIMEOUT_MS / 60_000} minutes`,
    transactionHash: hash,
  });
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
  // Set once the next-block check passes; later failures carry it.
  let nextBlock: NextBlockSimulation | undefined;
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

    const { gas: estimatedGas, simulation } = await estimateOuterGas(options, {
      to: request.safeAddress,
      data: outerCalldata,
      from: request.ownerAddress,
    });
    nextBlock = simulation;

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      options.chainId,
      undefined,
      undefined,
      options.rpcManager,
      options.feeOverrides?.priorityFeeOverride,
      options.feeOverrides?.maxFeeOverride
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
      options.rpcManager,
      options.sendReport
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = await waitForSafeReceipt(
      broadcast,
      options.rpcManager,
      "Safe-routed transaction",
      options.sendReport
    );
    throwIfReverted(receipt, gasConfig.gasLimit);

    await nonceManager.confirmTransaction(broadcast.hash);
    finishMetrics("success");
    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
      ...(simulation ? { simulation } : {}),
    };
  } catch (err) {
    finishOnError(
      finishMetrics,
      nextBlock ? tagNextBlockSimulation(err, nextBlock) : err
    );
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
  // Set once the next-block check passes; later failures carry it.
  let nextBlock: NextBlockSimulation | undefined;
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

    const { gas: estimatedGas, simulation } = await estimateOuterGas(options, {
      to: request.rolesModifierAddress,
      data: outerCalldata,
      from: request.delegateAddress,
    });
    nextBlock = simulation;

    const gasConfig = await gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      options.chainId,
      undefined,
      undefined,
      options.rpcManager,
      options.feeOverrides?.priorityFeeOverride,
      options.feeOverrides?.maxFeeOverride
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
      options.rpcManager,
      options.sendReport
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = await waitForSafeReceipt(
      broadcast,
      options.rpcManager,
      "Role-routed transaction",
      options.sendReport
    );
    throwIfReverted(receipt, gasConfig.gasLimit);
    await nonceManager.confirmTransaction(broadcast.hash);
    finishMetrics("success");
    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
      ...(simulation ? { simulation } : {}),
    };
  } catch (err) {
    finishOnError(
      finishMetrics,
      nextBlock ? tagNextBlockSimulation(err, nextBlock) : err
    );
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
      options.rpcManager,
      options.feeOverrides?.priorityFeeOverride,
      options.feeOverrides?.maxFeeOverride
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
      options.rpcManager,
      options.sendReport
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = await waitForSafeReceipt(
      broadcast,
      options.rpcManager,
      "Role-routed native transfer",
      options.sendReport
    );
    throwIfReverted(receipt, gasConfig.gasLimit);
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
      options.rpcManager,
      options.feeOverrides?.priorityFeeOverride,
      options.feeOverrides?.maxFeeOverride
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
      options.rpcManager,
      options.sendReport
    );

    await nonceManager.recordTransaction(
      session,
      nonce,
      broadcast.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = await waitForSafeReceipt(
      broadcast,
      options.rpcManager,
      "Safe-routed native transfer",
      options.sendReport
    );
    throwIfReverted(receipt, gasConfig.gasLimit);

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
