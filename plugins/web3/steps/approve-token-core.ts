/**
 * Core approve-token logic shared between web3 approve-token step and direct execution API.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple callers can reuse approval logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
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
import { getErrorMessage } from "@/lib/utils";
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
import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import { isSponsorshipSupported } from "@/lib/web3/turnkey-sponsorship-config";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { revertedTransactionHash } from "@/lib/web3/onchain-revert";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { executeSponsoredContractTransaction } from "@/lib/web3/sponsored-transaction-manager";
import type { ExecutedCall } from "@/lib/web3/trace-decode";
import { traceExecutedCallWithFailover } from "@/lib/web3/trace-executed-call";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import { parseTokenAddress } from "./transfer-token-core";

export type ApproveTokenCoreInput = {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  spenderAddress: string;
  amount: string;
  gasLimitMultiplier?: string;
  tokenAddress?: string;
  // KEEP-137: Route through private mempool (Flashbots Protect). Skips
  // Turnkey-sponsored execution -- mutually exclusive.
  usePrivateMempool?: boolean;
  // Strict mode: when true and usePrivateMempool is true, failing to reach the
  // private RPC does NOT fall back to the public mempool. Ignored otherwise.
  strict?: boolean;
  // Per-node Web3 Connection field. See parseWeb3Connection in
  // lib/safe/signer-resolver.ts. Missing -> "default" -> org-policy resolver.
  web3Connection?: string;
  _context?: {
    executionId?: string;
    organizationId?: string;
  };
};

export type ApproveTokenResult =
  | {
      success: true;
      transactionHash: string;
      // Chain the transaction was broadcast on, required for independent
      // on-chain receipt verification at execution finalize time.
      chainId: number;
      transactionLink: string;
      gasUsed: string;
      gasUsedUnits: string;
      effectiveGasPrice: string;
      approvedAmount: string;
      spender: string;
      symbol: string;
      sponsored?: boolean;
      // Normalized view of the call that actually executed, recovered by tracing
      // the transaction. Lets sponsored sends report the same shape as direct
      // ones. Omitted when the RPC cannot trace the transaction.
      executedCall?: ExecutedCall;
    }
  | {
      success: false;
      error: string;
      /**
       * Structured classification of the revert when one was emitted.
       * Omitted when the failure is pre-flight (validation, RPC) or when
       * the revert payload was empty / unrecognised.
       */
      rejection?: RevertKind;
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
 * Core approve token logic
 *
 * Calls ERC20 approve(spender, amount) on the selected token contract.
 * Supports human-readable amounts (converted via decimals) and "max" for unlimited approval.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Token approval handler with comprehensive validation and error handling
export async function approveTokenCore(
  input: ApproveTokenCoreInput
): Promise<ApproveTokenResult> {
  const {
    network,
    spenderAddress,
    amount,
    gasLimitMultiplier,
    usePrivateMempool,
    strict,
    web3Connection,
    _context,
  } = input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);

  // Get chain ID first (needed for token config parsing)
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Approve Token] Failed to resolve network",
      error,
      { plugin_name: "web3", action_name: "approve-token" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Parse token address from config
  const tokenAddress = await parseTokenAddress(input, chainId);

  // Validate token address
  if (!(tokenAddress && ethers.isAddress(tokenAddress))) {
    return {
      success: false,
      error: tokenAddress
        ? `Invalid token address: ${tokenAddress}`
        : "No token selected",
    };
  }

  // Validate spender address
  if (!ethers.isAddress(spenderAddress)) {
    return {
      success: false,
      error: `Invalid spender address: ${spenderAddress}`,
    };
  }

  // Validate amount
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  // Resolve organization context
  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Approve Token]",
    "approve-token"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const { organizationId, userId } = orgCtx;

  // Resolve RPC config (with failover)
  let rpcUrl: string;
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
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
      "[Approve Token] Failed to resolve RPC config",
      error,
      {
        plugin_name: "web3",
        action_name: "approve-token",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Get wallet address for nonce management
  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
    };
  }

  // Decide whether to route this write through the org's Safe on this chain.
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
    };
  }

  // Get workflow ID for transaction tracking (only for workflow executions)
  let workflowId: string | undefined;
  if (_context.executionId && !_context.organizationId) {
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

  // Build transaction context
  const txContext: TransactionContext = {
    organizationId,
    executionId: _context.executionId ?? `direct-${generateId()}`,
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
    isSponsorshipSupported(chainId) &&
    !usePrivateMempool &&
    signerMode.kind === SIGNER_MODE.EOA &&
    isGasSponsorshipEnabled()
  ) {
    try {
      const [decimals, symbol] = await rpcManager.executeWithFailover(
        (p) => {
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, p);
          return Promise.all([
            tokenContract.decimals() as Promise<bigint>,
            tokenContract.symbol() as Promise<string>,
          ]);
        }
      );

      let amountRaw: bigint;
      let approvedAmountDisplay: string;
      if (amount.trim().toLowerCase() === "max") {
        amountRaw = ethers.MaxUint256;
        approvedAmountDisplay = "unlimited";
      } else {
        amountRaw = ethers.parseUnits(amount, Number(decimals));
        approvedAmountDisplay = amount;
      }

      const sponsoredResult = await executeSponsoredContractTransaction({
        organizationId,
        executionId: _context.executionId ?? "direct-execution",
        chainId,
        rpcUrl,
        walletAddress,
        to: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spenderAddress, amountRaw],
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
          { target: tokenAddress, abi: ERC20_ABI, functionName: "approve" }
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
          approvedAmount: approvedAmountDisplay,
          spender: spenderAddress,
          symbol,
          executedCall,
        };
      }

      logUserError(
        ErrorCategory.TRANSACTION,
        "[Approve Token] Sponsorship skipped (credits exhausted, chain unsupported, or client creation failed), falling back to direct signing",
        undefined,
        {
          plugin_name: "web3",
          action_name: "approve-token",
          chain_id: String(chainId),
        }
      );
    } catch (error) {
      const decision = resolveSponsoredSendError(error, {
        logPrefix: "[Approve Token]",
        actionName: "approve-token",
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

    // Keep contract instance for error formatting in catch block
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    try {
      // Get token decimals and symbol via failover
      const [decimals, symbol] = await rpcManager.executeWithFailover(
        (p) => {
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, p);
          return Promise.all([
            tokenContract.decimals() as Promise<bigint>,
            tokenContract.symbol() as Promise<string>,
          ]);
        }
      );

      const decimalsNum = Number(decimals);

      // Convert amount to raw units (handle "max" for unlimited approval)
      let amountRaw: bigint;
      let approvedAmountDisplay: string;
      if (amount.trim().toLowerCase() === "max") {
        amountRaw = ethers.MaxUint256;
        approvedAmountDisplay = "unlimited";
      } else {
        try {
          amountRaw = ethers.parseUnits(amount, decimalsNum);
          approvedAmountDisplay = amount;
        } catch (error) {
          return {
            success: false,
            error: `Invalid amount format: ${getErrorMessage(error)}`,
          };
        }
      }

      let receipt: Awaited<ReturnType<typeof adapter.executeContractCall>>;
      if (signerMode.kind === SIGNER_MODE.SAFE_ROLE) {
        receipt = await executeContractCallAsRole(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            delegateAddress: signerMode.delegateAddress,
            rolesModifierAddress: signerMode.rolesModifierAddress,
            roleKey: signerMode.roleKey,
            contractAddress: tokenAddress,
            abi: ERC20_ABI,
            functionKey: "approve",
            args: [spenderAddress, amountRaw],
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
            contractAddress: tokenAddress,
            abi: ERC20_ABI,
            functionKey: "approve",
            args: [spenderAddress, amountRaw],
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
            contractAddress: tokenAddress,
            abi: ERC20_ABI,
            functionKey: "approve",
            args: [spenderAddress, amountRaw],
          },
          session,
          {
            gasOverrides: { multiplierOverride, gasLimitOverride },
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
        target: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
      });

      return {
        success: true,
        transactionHash: receipt.hash,
        chainId,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
        approvedAmount: approvedAmountDisplay,
        spender: spenderAddress,
        symbol,
        executedCall,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Approve Token] Transaction failed",
        error,
        {
          plugin_name: "web3",
          action_name: "approve-token",
          chain_id: String(chainId),
        }
      );
      const rejection = classifyRevert(error, contract.interface);
      return {
        success: false,
        error: formatContractError(
          error,
          contract.interface,
          "Token approval failed"
        ),
        ...(rejection.kind !== "unknown" ? { rejection } : {}),
        ...(revertedTransactionHash(error)
          ? { transactionHash: revertedTransactionHash(error), chainId }
          : {}),
      };
    }
  });
}
