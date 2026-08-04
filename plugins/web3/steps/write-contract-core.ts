/**
 * Core write-contract logic shared between web3 write-contract and protocol-write steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple step files can reuse write logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { validateArgsForAbi } from "@/lib/abi/validate-args";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/web3/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { findAbiFunction } from "@/lib/abi/utils";
import { getErrorMessage } from "@/lib/utils";
import { getAbiFunctionKey } from "@/lib/abi/function-key";
import { generateId } from "@/lib/utils/id";
import {
  executeContractCallAsRole,
  executeContractCallAsSafe,
} from "@/lib/safe/execute-as-safe";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import {
  classifyRevert,
  formatContractError,
  type RevertKind,
} from "@/lib/web3/decode-revert-error";
import {
  parsePriorityFeeGwei,
  resolveGasLimitOverrides,
} from "@/lib/web3/gas-defaults";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { executeSponsoredContractTransaction } from "@/lib/web3/sponsored-transaction-manager";
import type { ExecutedCall } from "@/lib/web3/trace-decode";
import { traceExecutedCallWithFailover } from "@/lib/web3/trace-executed-call";
import { revertedTransactionHash } from "@/lib/web3/onchain-revert";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

export type WriteContractCoreInput = {
  contractAddress: string;
  network: string;
  abi: string;
  abiFunction: string;
  functionArgs?: string;
  ethValue?: string;
  gasLimitMultiplier?: string;
  // Explicit caller override for maxPriorityFeePerGas (in gwei). Bypasses the
  // chain's min/max priority-fee clamp in lib/web3/gas-strategy.ts. Use when
  // the network's mempool requires a tip above the configured floor (e.g. 0G
  // Galileo demands >= 2 gwei but the strategy floor is lower).
  priorityFeeGwei?: string;
  // KEEP-137: Route the write transaction through the chain's private mempool
  // RPC (e.g. Flashbots Protect). Skips Turnkey-sponsored execution -- mutually exclusive.
  usePrivateMempool?: boolean;
  // When true and usePrivateMempool is true, failing to reach the private RPC
  // does NOT fall back to the public mempool. Ignored when usePrivateMempool is false.
  strict?: boolean;
  // Per-node Web3 Connection field. See ParsedWeb3Connection / parseWeb3Connection
  // in lib/safe/signer-resolver.ts. Missing -> "default" -> org-policy resolver.
  web3Connection?: string;
  _context?: {
    executionId?: string;
    organizationId?: string;
  };
};

export type WriteContractResult =
  | {
      success: true;
      transactionHash: string;
      // KEEP-966: chain the transaction was broadcast on, required for
      // independent on-chain receipt verification at execution finalize time.
      chainId: number;
      transactionLink: string;
      gasUsed: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
      result?: unknown;
      sponsored?: boolean;
      // Normalized view of the call that actually executed against the target
      // contract, recovered by tracing the transaction. For sponsored sends the
      // top-level `to` is a relayer/wrapper, so this is the only consistent way
      // to report "what ran" identically to a direct send. Omitted when the RPC
      // cannot trace the transaction.
      executedCall?: ExecutedCall;
    }
  | {
      success: false;
      error: string;
      rejection?: RevertKind;
      errorClass?: ExecutionErrorType;
      // Set only when a transaction reached the chain and failed
      // there, so the finalizer can persist a receipt for the failure. Absent
      // on pre-broadcast failures, where no transaction exists.
      transactionHash?: string;
      chainId?: number;
      // True when the terminal failure came from the gas-sponsored path, so
      // the finalizer can report the route accurately on a failed execution.
      sponsored?: boolean;
    };

/**
 * Core write contract logic
 *
 * Shared between the web3 write-contract step and the future protocol-write step.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contract interaction requires extensive validation
export async function writeContractCore(
  input: WriteContractCoreInput
): Promise<WriteContractResult> {
  const {
    contractAddress,
    network,
    abi,
    abiFunction,
    functionArgs,
    ethValue,
    gasLimitMultiplier,
    priorityFeeGwei,
    usePrivateMempool,
    strict,
    web3Connection,
    _context,
  } = input;

  if (!abiFunction || abiFunction.trim() === "") {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Write Contract] Missing abiFunction",
      { abiFunction },
      { plugin_name: "web3", action_name: "write-contract" }
    );
    return {
      success: false,
      error: "Missing `abiFunction` in the step config",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);
  const priorityFeeOverride = parsePriorityFeeGwei(priorityFeeGwei);

  // Validate contract address
  if (!ethers.isAddress(contractAddress)) {
    return {
      success: false,
      error: `Invalid contract address: ${contractAddress}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Parse ABI
  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch (error) {
    return {
      success: false,
      error: `Invalid ABI JSON: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  // Validate ABI is an array
  if (!Array.isArray(parsedAbi)) {
    return {
      success: false,
      error: "ABI must be a JSON array",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const functionAbi = findAbiFunction(parsedAbi, abiFunction);

  if (!functionAbi) {
    return {
      success: false,
      error: `Function '${abiFunction}' not found in ABI`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const abiFunctionKey = getAbiFunctionKey(parsedAbi, abiFunction, functionAbi);

  // Parse function arguments
  let args: unknown[] = [];
  if (functionArgs && functionArgs.trim() !== "") {
    try {
      const parsedArgs = JSON.parse(functionArgs);
      if (!Array.isArray(parsedArgs)) {
        return {
          success: false,
          error: "Function arguments must be a JSON array",
          errorClass: ExecutionErrorType.USER,
        };
      }
      // Filter out empty strings at the end of the array (from UI padding)
      args = parsedArgs.filter((arg, index) => {
        // Keep all non-empty values
        if (arg !== "") {
          return true;
        }
        // Keep empty strings if they're not at the end
        return parsedArgs.slice(index + 1).some((a) => a !== "");
      });
      args = reshapeArgsForAbi(args, functionAbi);
      args = coerceArgsForAbi(args, functionAbi);
      const validation = validateArgsForAbi(args, functionAbi);
      if (!validation.ok) {
        return {
          success: false,
          error: `Invalid function arguments: ${validation.error}`,
          errorClass: ExecutionErrorType.USER,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Invalid function arguments JSON: ${getErrorMessage(error)}`,
        errorClass: ExecutionErrorType.USER,
      };
    }
  }

  // Get organizationId from _context (direct execution provides it, workflow execution derives it)
  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Write Contract]",
    "write-contract"
  );
  if (!orgCtx.success) {
    return { success: false, error: orgCtx.error, errorClass: ExecutionErrorType.SYSTEM };
  }
  const { organizationId, userId } = orgCtx;

  // Get chain ID and resolve RPC config (with user preferences + failover)
  let chainId: number;
  let rpcUrl: string;
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    chainId = getChainIdFromNetwork(network);

    rpcManager = await getRpcProvider({
      chainId,
      userId,
      usePrivateMempool,
      strict,
    });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Write Contract] Failed to resolve RPC config",
      error,
      {
        plugin_name: "web3",
        action_name: "write-contract",
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  // Get wallet address for nonce management
  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }

  // Decide whether to route this write through the org's Safe on this chain.
  // In "safe" mode msg.sender at the target contract becomes the Safe address;
  // the Turnkey EOA still signs the outer tx and pays gas.
  let signerMode: Awaited<ReturnType<typeof resolveSignerForNode>>;
  try {
    signerMode = await resolveSignerForNode({
      organizationId,
      chainId,
      web3Connection,
    });
  } catch (error) {
    return {
      success: false,
      error: `Failed to resolve Web3 Connection: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.SYSTEM,
    };
  }

  // Get workflow ID for transaction tracking (only for workflow executions)
  let workflowId: string | undefined;
  if (_context?.executionId && !_context?.organizationId) {
    try {
      const execution = await db
        .select({ workflowId: workflowExecutions.workflowId })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, _context.executionId))
        .then((rows) => rows[0]);
      workflowId = execution?.workflowId ?? undefined;
    } catch {
      // Non-critical - workflowId is optional for tracking
    }
  }

  // Parse ethValue early so we fail fast with a friendly message.
  // Reject any non-zero value sent to a non-payable function: the UI hides
  // the field for non-payable functions, but the API and workflow layers
  // accept ethValue as an arbitrary string, so this is the authoritative
  // server-side guard against accidentally sending native tokens to a
  // function that cannot accept them (the tx would revert on-chain anyway,
  // but failing here is faster, cheaper, and produces a clearer error).
  let parsedEthValue: bigint | undefined;
  if (ethValue && ethValue.trim() !== "") {
    try {
      parsedEthValue = ethers.parseEther(ethValue);
    } catch {
      return {
        success: false,
        error: `Invalid payable value "${ethValue}" -- expected a decimal string like "0.1" or "1.5"`,
        errorClass: ExecutionErrorType.USER,
      };
    }

    if (
      parsedEthValue > BigInt(0) &&
      (functionAbi as { stateMutability?: string }).stateMutability !==
        "payable"
    ) {
      return {
        success: false,
        error: `Function '${abiFunction}' is not payable -- cannot send a non-zero value with this call`,
        errorClass: ExecutionErrorType.USER,
      };
    }
  }

  // Build transaction context
  const txContext: TransactionContext = {
    organizationId,
    executionId: _context?.executionId ?? `direct-${generateId()}`,
    workflowId,
    chainId,
    rpcUrl,
    rpcManager,
  };

  // Try gas-sponsored execution first via Turnkey Gas Station (KEEP-464).
  // KEEP-137: skip sponsorship when routing through a private mempool --
  // Turnkey broadcasts via its own infrastructure, which bypasses Flashbots Protect.
  // Also skip in Safe mode: the sponsored path sends from the org's EOA wallet,
  // which would change msg.sender away from the Safe.
  if (
    !usePrivateMempool &&
    signerMode.kind === SIGNER_MODE.EOA &&
    isGasSponsorshipEnabled()
  ) {
    try {
      const sponsoredResult = await executeSponsoredContractTransaction({
        organizationId,
        executionId: _context?.executionId ?? "direct-execution",
        chainId,
        rpcUrl,
        walletAddress,
        to: contractAddress,
        // biome-ignore lint/suspicious/noExplicitAny: ABI parsed from user-provided JSON string, type is unknown[]
        abi: parsedAbi as any,
        functionName: abiFunction,
        args,
        value: parsedEthValue,
      });

      if (sponsoredResult !== null) {
        const explorerConfig = await db.query.explorerConfigs.findFirst({
          where: eq(explorerConfigs.chainId, chainId),
        });
        const transactionLink = explorerConfig
          ? getTransactionUrl(explorerConfig, sponsoredResult.transactionHash)
          : "";

        const executedCall = await traceExecutedCallWithFailover(
          rpcManager,
          sponsoredResult.transactionHash,
          { target: contractAddress, abi: parsedAbi, functionName: abiFunction }
        );

        return {
          success: true,
          sponsored: true,
          transactionHash: sponsoredResult.transactionHash,
          chainId,
          transactionLink,
          gasUsed: sponsoredResult.gasUsed,
          gasUsedUnits: sponsoredResult.gasUsedUnits,
          effectiveGasPrice: sponsoredResult.effectiveGasPrice,
          executedCall,
        };
      }

      logUserError(
        ErrorCategory.TRANSACTION,
        "[Write Contract] Sponsorship skipped (credits exhausted, chain unsupported, or client creation failed), falling back to direct signing",
        undefined,
        {
          plugin_name: "web3",
          action_name: "write-contract",
          chain_id: String(chainId),
        }
      );
    } catch (error) {
      const decision = resolveSponsoredSendError(error, {
        logPrefix: "[Write Contract]",
        actionName: "write-contract",
        chainId,
      });
      if (!decision.fallback) {
        return {
          success: false,
          error: decision.error,
          sponsored: true,
          ...(decision.transactionHash
            ? { transactionHash: decision.transactionHash, chainId }
            : {}),
        };
      }
    }
  }

  // Fall back to direct signing with nonce management and RPC failover
  const adapter = getChainAdapter(chainId);

  return withNonceSession(txContext, walletAddress, async (session) => {
    // Initialize wallet signer
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Create a contract interface for error formatting on failure
    let contractInterface: ethers.Interface | undefined;
    try {
      contractInterface = new ethers.Interface(parsedAbi as ethers.InterfaceAbi);
    } catch {
      // Non-critical -- error formatting will fall back to generic messages
    }

    try {
      let receipt: Awaited<ReturnType<typeof adapter.executeContractCall>>;
      if (signerMode.kind === SIGNER_MODE.SAFE_ROLE) {
        receipt = await executeContractCallAsRole(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            delegateAddress: signerMode.delegateAddress,
            rolesModifierAddress: signerMode.rolesModifierAddress,
            roleKey: signerMode.roleKey,
            contractAddress,
            abi: parsedAbi as ethers.InterfaceAbi,
            functionKey: abiFunctionKey,
            args,
            value: parsedEthValue,
          },
          session,
          {
            chainId,
            workflowId,
            rpcManager,
          }
        );
      } else if (signerMode.kind === SIGNER_MODE.SAFE) {
        receipt = await executeContractCallAsSafe(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            ownerAddress: signerMode.ownerAddress,
            contractAddress,
            abi: parsedAbi as ethers.InterfaceAbi,
            functionKey: abiFunctionKey,
            args,
            value: parsedEthValue,
          },
          session,
          {
            chainId,
            workflowId,
            rpcManager,
          }
        );
      } else {
        receipt = await adapter.executeContractCall(
          signer,
          {
            contractAddress,
            abi: parsedAbi as ethers.InterfaceAbi,
            functionKey: abiFunctionKey,
            args,
            value: parsedEthValue,
          },
          session,
          {
            gasOverrides: {
              multiplierOverride,
              gasLimitOverride,
              priorityFeeOverride,
            },
            workflowId,
            rpcManager,
          }
        );
      }

      const gasUsedUnits = receipt.gasUsed.toString();
      const effectiveGasPrice = receipt.effectiveGasPrice.toString();
      const gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);

      const executedCall = await traceExecutedCallWithFailover(rpcManager, receipt.hash, {
        target: contractAddress,
        abi: parsedAbi,
        functionName: abiFunction,
      });

      return {
        success: true,
        transactionHash: receipt.hash,
        chainId,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
        result: undefined,
        executedCall,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[Write Contract] Function call failed",
        error,
        {
          plugin_name: "web3",
          action_name: "write-contract",
          chain_id: String(chainId),
        }
      );
      const rejection = classifyRevert(error, contractInterface);
      const revertedHash = revertedTransactionHash(error);
      return {
        success: false,
        error: formatContractError(error, contractInterface),
        ...(rejection.kind !== "unknown" ? { rejection } : {}),
        ...(revertedHash
          ? { transactionHash: revertedHash, chainId }
          : {}),
      };
    }
  });
}
