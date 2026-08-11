/**
 * Core transfer-funds logic shared between web3 transfer-funds step and direct execution API.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple callers can reuse transfer logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import {
  describeNativeShortfall,
  getNativeSymbol,
} from "@/lib/execute/native-balance";
import { getTransactionUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeSolanaWallet,
  initializeWalletSigner,
} from "@/lib/web3/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import { rpcRelayErrorClass } from "@/lib/rpc/providers";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import { generateId } from "@/lib/utils/id";
import { PublicKey } from "@solana/web3.js";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import type { NonceSession } from "@/lib/web3/nonce-manager";
import {
  executeNativeTransferAsRole,
  executeNativeTransferAsSafe,
} from "@/lib/safe/execute-as-safe";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import {
  preflightGasBalance,
  resolveFundingHolder,
} from "@/lib/web3/gas-preflight";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import {
  classifyRevert,
  formatContractError,
  type RevertKind,
} from "@/lib/web3/decode-revert-error";
import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  computeSolanaLamportFee,
  SOLANA_BASE_FEE_LAMPORTS,
} from "@/lib/web3/solana-fees";
import { revertedTransactionHash } from "@/lib/web3/onchain-revert";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { executeSponsoredTransaction } from "@/lib/web3/sponsored-transaction-manager";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

// Tempo (4217 mainnet, 42431 testnet) has no native gas token: value moves via
// TIP-20 transfers, so a native send has no valid form and reverts at preflight.
const TEMPO_CHAIN_IDS = new Set([4217, 42_431]);

export type TransferFundsCoreInput = {
  network: string;
  amount: string;
  recipientAddress: string;
  gasLimitMultiplier?: string;
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

export type TransferFundsResult =
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
      sponsored?: boolean;
    }
  | {
      success: false;
      error: string;
      rejection?: RevertKind;
      // Authoritative fault domain when the failure site knows it: the
      // private-mempool relay never answered, and we do not run that node.
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
 * Core transfer funds logic
 *
 * Shared between the web3 transfer-funds step and the direct execution API.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Transfer handler with sponsorship attempt + fallback + validation
export async function transferFundsCore(
  input: TransferFundsCoreInput
): Promise<TransferFundsResult> {
  const {
    network,
    amount,
    recipientAddress,
    gasLimitMultiplier,
    usePrivateMempool,
    strict,
    web3Connection,
    _context,
  } = input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);

  // Wrap network parsing to avoid throwing uncaught errors for invalid networks before branching
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  // Branch early to Solana-specific path
  if (isSolanaTransferPath(chainId)) {
    return transferFundsSolana({
      chainId,
      amount,
      recipientAddress,
      gasLimitMultiplier,
      _context,
    });
  }

  // Tempo has no native token to move; fail with a clear message instead of the
  // opaque CALL_EXCEPTION an empty data preflight would otherwise return.
  if (TEMPO_CHAIN_IDS.has(chainId)) {
    return {
      success: false,
      error:
        "Tempo has no native token to transfer. Send a TIP-20 stablecoin instead by providing a token address.",
    };
  }

  // Validate recipient address
  if (!ethers.isAddress(recipientAddress)) {
    return {
      success: false,
      error: `Invalid recipient address: ${recipientAddress}`,
    };
  }

  // Validate amount
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  let amountInWei: bigint;
  try {
    amountInWei = ethers.parseEther(amount);
  } catch (error) {
    return {
      success: false,
      error: `Invalid amount format: ${getErrorMessage(error)}`,
    };
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
    "[Transfer Funds]",
    "transfer-funds"
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
      "[Transfer Funds] Failed to resolve RPC config",
      error,
      { plugin_name: "web3", action_name: "transfer-funds" }
    );
    const errorClass = rpcRelayErrorClass(error);
    return {
      success: false,
      error: getErrorMessage(error),
      ...(errorClass ? { errorClass } : {}),
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

  // KEEP-137: skip sponsorship when routing through a private mempool --
  // Turnkey broadcasts via its own infrastructure, which bypasses Flashbots Protect.
  // Also skip in Safe mode: the sponsored path sends from the org's EOA wallet,
  // which would change msg.sender away from the Safe.
  if (
    !usePrivateMempool &&
    signerMode.kind === SIGNER_MODE.EOA &&
    isGasSponsorshipEnabled()
  ) {
    // Try gas-sponsored execution first via Turnkey Gas Station (KEEP-464)
    try {
      const sponsoredResult = await executeSponsoredTransaction({
        organizationId,
        executionId: _context.executionId ?? "direct-execution",
        chainId,
        rpcUrl,
        walletAddress,
        to: recipientAddress,
        value: amountInWei,
      });

      if (sponsoredResult !== null) {
        const explorerConfig = await db.query.explorerConfigs.findFirst({
          where: eq(explorerConfigs.chainId, chainId),
        });
        const transactionLink = explorerConfig
          ? getTransactionUrl(explorerConfig, sponsoredResult.transactionHash)
          : "";

        return {
          success: true,
          sponsored: true,
          transactionHash: sponsoredResult.transactionHash,
          chainId,
          transactionLink,
          gasUsed: sponsoredResult.gasUsed,
          gasUsedUnits: sponsoredResult.gasUsedUnits,
          effectiveGasPrice: sponsoredResult.effectiveGasPrice,
        };
      }

      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Funds] Sponsorship skipped (credits exhausted, chain unsupported, or client creation failed), falling back to direct signing",
        undefined,
        {
          plugin_name: "web3",
          action_name: "transfer-funds",
          chain_id: String(chainId),
        }
      );
    } catch (error) {
      const decision = resolveSponsoredSendError(error, {
        logPrefix: "[Transfer Funds]",
        actionName: "transfer-funds",
        chainId,
      });
      if (!decision.fallback) {
        return {
          success: false,
          error: decision.error,
          // Carried so a failOnError=false node cannot soften an unresolved
          // in-flight send into success.
          errorClass: decision.errorClass,
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

  // Answer affordability before queueing on the wallet's nonce lock. A holder
  // that cannot pay would otherwise take the lock, spend a full failover round
  // discovering that at broadcast, and stall every other execution for the
  // same wallet behind it. The in-session check below stays as the backstop
  // for when this one fails open on an RPC error.
  const gasCheck = await preflightGasBalance({
    rpcManager,
    chainId,
    holderAddress: resolveFundingHolder(signerMode, walletAddress),
    valueWei: amountInWei,
  });
  if (!gasCheck.affordable) {
    return { success: false, error: gasCheck.message };
  }

  return withNonceSession(txContext, walletAddress, async (session) => {
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Preflight native balance check. Mirrors the ERC-20 preflight in
    // transfer-token-core: read the funding address' native balance and
    // short-circuit with a clean message before the orchestrator simulates
    // and surfaces a cryptic revert. Holder is the Safe in safe / safe-role
    // mode (funds come from the Safe's balance), otherwise the EOA. An
    // RPC failure here surfaces as a step error to stay consistent with
    // transfer-token-core's pattern. See review #923-r3 (MEDIUM).
    const fundingHolderAddress: string =
      signerMode.kind === SIGNER_MODE.SAFE_ROLE || signerMode.kind === SIGNER_MODE.SAFE
        ? signerMode.safeAddress
        : walletAddress;
    const nativeBalance = await rpcManager.executeWithFailover(
      (p) => p.getBalance(fundingHolderAddress),
      "preflight"
    );
    if (nativeBalance < amountInWei) {
      // Wording (and the chain's native symbol, so the error reads
      // "Insufficient ETH balance" rather than the chain-agnostic "native")
      // comes from lib/execute/native-balance, shared with the dry-run
      // simulator so the two paths cannot drift. Looked up lazily because
      // this branch only fires on the slow / unhappy path.
      const shortfall = describeNativeShortfall({
        symbol: await getNativeSymbol(chainId),
        balance: nativeBalance,
        required: amountInWei,
      });
      return {
        success: false,
        error: shortfall.message,
      };
    }

    try {
      let receipt: Awaited<ReturnType<typeof adapter.sendTransaction>>;
      if (signerMode.kind === SIGNER_MODE.SAFE_ROLE) {
        receipt = await executeNativeTransferAsRole(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            delegateAddress: signerMode.delegateAddress,
            rolesModifierAddress: signerMode.rolesModifierAddress,
            roleKey: signerMode.roleKey,
            to: recipientAddress,
            amount: amountInWei,
          },
          session,
          {
            chainId,
            workflowId,
            rpcManager,
          }
        );
      } else if (signerMode.kind === SIGNER_MODE.SAFE) {
        receipt = await executeNativeTransferAsSafe(
          signer,
          {
            safeAddress: signerMode.safeAddress,
            ownerAddress: signerMode.ownerAddress,
            to: recipientAddress,
            amount: amountInWei,
          },
          session,
          {
            chainId,
            workflowId,
            rpcManager,
          }
        );
      } else {
        receipt = await adapter.sendTransaction(
          signer,
          {
            to: recipientAddress,
            value: amountInWei,
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

      return {
        success: true,
        transactionHash: receipt.hash,
        chainId,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Funds] Transaction failed",
        error,
        {
          plugin_name: "web3",
          action_name: "transfer-funds",
          chain_id: String(chainId),
        }
      );
      const rejection = classifyRevert(error);
      const errorClass = rpcRelayErrorClass(error);
      return {
        success: false,
        error: formatContractError(error, undefined, "Transaction failed"),
        ...(errorClass ? { errorClass } : {}),
        ...(rejection.kind !== "unknown" ? { rejection } : {}),
        ...(revertedTransactionHash(error)
          ? { transactionHash: revertedTransactionHash(error), chainId }
          : {}),
      };
    }
  });
}

/**
 * Pure helper for dispatch routing tests.
 */
export function isSolanaTransferPath(chainId: number): boolean {
  return isSolanaChain(chainId);
}



/**
 * Early-branch Solana native transfer handler.
 */
async function transferFundsSolana(args: {
  chainId: number;
  amount: string;
  recipientAddress: string;
  gasLimitMultiplier?: string;
  _context?: { executionId?: string; organizationId?: string };
}): Promise<TransferFundsResult> {
  const { chainId, amount, recipientAddress, gasLimitMultiplier, _context } = args;

  // 1. Amount present check
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  // 2. Validate recipient address (must be valid Solana base58 address)
  try {
    new PublicKey(recipientAddress);
  } catch {
    return {
      success: false,
      error: `Invalid Solana recipient address: ${recipientAddress}`,
    };
  }

  // 3. Parse amount to lamports
  let lamports: bigint;
  try {
    lamports = ethers.parseUnits(amount.trim(), 9); // 9 decimals = lamports
    if (lamports <= BigInt(0)) {
      if (lamports === BigInt(0)) {
        return {
          success: false,
          error: "SOL amount must be greater than zero",
        };
      }
      throw new Error("Negative amount");
    }
  } catch {
    return { success: false, error: `Invalid SOL amount: ${amount}` };
  }

  // 4. Resolve organization context
  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Transfer Funds - Solana]",
    "transfer-funds"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }
  const { organizationId } = orgCtx;

  // 5. Get signer and wallet address (one fetch, one validation check)
  let solanaSigner: SolanaTransactionSigner;
  let orgSolanaAddress: string;
  try {
    ({ signer: solanaSigner, address: orgSolanaAddress } =
      await initializeSolanaWallet(organizationId));
  } catch (error) {
    return {
      success: false,
      error: `Failed to initialize Solana wallet: ${getErrorMessage(error)}`,
    };
  }

  // 6. Get adapter (owns RPC resolution internally)
  const adapter = getChainAdapter(chainId);

  // 7. Balance preflight check
  try {
    // SolanaChainAdapter owns its own provider manager and ignores rpcManager.
    const balance = await adapter.getBalance(undefined, orgSolanaAddress);
    // Reserve the base transaction fee (5000 lamports per signature) on top of
    // the transfer amount. Without this a max-balance transfer passes preflight
    // and then fails at inclusion for not covering its own fee.
    const requiredLamports = lamports + SOLANA_BASE_FEE_LAMPORTS;
    if (balance < requiredLamports) {
      return {
        success: false,
        error: `Insufficient SOL balance. Have: ${balance.toString()} lamports, Need: ${requiredLamports.toString()} lamports (${lamports.toString()} transfer + ${SOLANA_BASE_FEE_LAMPORTS.toString()} fee)`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to check SOL balance: ${getErrorMessage(error)}`,
    };
  }

  // 8. Resolve gas overrides (multiplierOverride is a no-op on Solana path)
  const { gasLimitOverride } = resolveGasLimitOverrides(gasLimitMultiplier);

  // 9. Call adapter.sendTransaction
  try {
    const receipt = await adapter.sendTransaction(
      undefined as unknown as ethers.Signer, // unused by SolanaChainAdapter
      {
        to: recipientAddress,
        value: lamports,
      },
      undefined as unknown as NonceSession, // unused by SolanaChainAdapter
      {
        solanaSigner,
        gasOverrides: { gasLimitOverride },
      }
    );

    const transactionLink = await adapter.getTransactionUrl(receipt.hash);

    // Prefer the fee the chain reported; the compute-budget reconstruction is
    // only a fallback for a receipt that carries no fee.
    const lamportFee =
      receipt.feeLamports ??
      computeSolanaLamportFee(receipt.gasUsed, receipt.effectiveGasPrice);

    return {
      success: true,
      transactionHash: receipt.hash,
      chainId,
      transactionLink,
      gasUsed: lamportFee.toString(),
      gasUsedUnits: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    };
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Transfer Funds - Solana] Transaction failed",
      error,
      {
        plugin_name: "web3",
        action_name: "transfer-funds",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}
