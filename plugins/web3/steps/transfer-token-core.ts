/**
 * Core transfer-token logic shared between web3 transfer-token step and direct execution API.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple callers can reuse transfer logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { ethers } from "ethers";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { db } from "@/lib/db";
import {
  explorerConfigs,
  supportedTokens,
  workflowExecutions,
} from "@/lib/db/schema";
import { checkStablecoinTransferAmount } from "@/lib/execute/stablecoin-cap";
import { getTransactionUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/web3/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { rpcRelayErrorClass } from "@/lib/rpc/providers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import { generateId } from "@/lib/utils/id";
import {
  executeContractCallAsRole,
  executeContractCallAsSafe,
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
import { isSponsorshipSupported } from "@/lib/web3/turnkey-sponsorship-config";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import {
  broadcastTransactionHash,
  isOnChainPendingError,
} from "@/lib/web3/onchain-revert";
import { resolveSponsoredSendError } from "@/lib/web3/sponsored-send-error";
import { executeSponsoredContractTransaction } from "@/lib/web3/sponsored-transaction-manager";
import type { ExecutedCall } from "@/lib/web3/trace-decode";
import { traceExecutedCallWithFailover } from "@/lib/web3/trace-executed-call";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import {
  convertAmountForWrite,
  rawToUi,
  resolveForWrite,
} from "@/lib/web3/ui-multiplier";

export type TransferTokenCoreInput = {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  recipientAddress: string;
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
    // Populated directly by the workflow executor's StepContext on every
    // real workflow execution (see executor.workflow.ts). When present,
    // skip the DB lookup below entirely; it exists only as a fallback for
    // callers that supply executionId without it.
    workflowId?: string;
  };
};

export type TransferTokenResult =
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
      amount: string;
      symbol: string;
      recipient: string;
      sponsored?: boolean;
      // Normalized view of the call that actually executed, recovered by tracing
      // the transaction. Lets sponsored sends report the same shape as direct
      // ones. Omitted when the RPC cannot trace the transaction.
      executedCall?: ExecutedCall;
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
 * Parse token config from input and return a single token address.
 * Supports both new (single token) and legacy (array) formats.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles multiple token config formats for backwards compatibility
export async function parseTokenAddress(
  input: Pick<TransferTokenCoreInput, "tokenConfig" | "tokenAddress">,
  chainId: number
): Promise<string | null> {
  // Legacy support: if tokenAddress is provided directly, use it
  if (input.tokenAddress && !input.tokenConfig) {
    return input.tokenAddress;
  }

  if (!input.tokenConfig) {
    return null;
  }

  // Object values from API/MCP-created workflows -- normalize to parsed form
  const parsed =
    typeof input.tokenConfig === "object"
      ? input.tokenConfig
      : (() => {
          try {
            return JSON.parse(input.tokenConfig as string);
          } catch {
            return null;
          }
        })();

  if (!parsed) {
    // JSON parse failed -- check if it's a bare address string
    if (
      typeof input.tokenConfig === "string" &&
      input.tokenConfig.startsWith("0x")
    ) {
      return input.tokenConfig;
    }
    return null;
  }

  // New format: single supported token ID
  if (parsed.supportedTokenId) {
    const tokens = await db
      .select({ tokenAddress: supportedTokens.tokenAddress })
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, chainId),
          eq(supportedTokens.id, parsed.supportedTokenId)
        )
      )
      .limit(1);
    if (tokens[0]?.tokenAddress) {
      return tokens[0].tokenAddress;
    }
  }

  // Legacy format: array of supported token IDs - use first
  if (
    Array.isArray(parsed.supportedTokenIds) &&
    parsed.supportedTokenIds.length > 0
  ) {
    const tokens = await db
      .select({ tokenAddress: supportedTokens.tokenAddress })
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, chainId),
          inArray(supportedTokens.id, parsed.supportedTokenIds)
        )
      )
      .limit(1);
    if (tokens[0]?.tokenAddress) {
      return tokens[0].tokenAddress;
    }
  }

  // New format: single custom token
  if (parsed.customToken?.address) {
    return parsed.customToken.address;
  }

  // Legacy format: array of custom tokens - use first
  if (Array.isArray(parsed.customTokens) && parsed.customTokens.length > 0) {
    return parsed.customTokens[0].address;
  }

  // Legacy: check old formats
  if (
    Array.isArray(parsed.customTokenAddresses) &&
    parsed.customTokenAddresses.length > 0
  ) {
    const addr = parsed.customTokenAddresses.find(
      (a: string) => a && a.trim() !== ""
    );
    if (addr) {
      return addr;
    }
  } else if (parsed.customTokenAddress) {
    return parsed.customTokenAddress;
  }

  return null;
}

/**
 * Core transfer token logic
 *
 * Shared between the web3 transfer-token step and the direct execution API.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Token transfer handler with comprehensive validation and error handling
export async function transferTokenCore(
  input: TransferTokenCoreInput
): Promise<TransferTokenResult> {
  const {
    network,
    recipientAddress,
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
      "[Transfer Token] Failed to resolve network",
      error,
      { plugin_name: "web3", action_name: "transfer-token" }
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

  // Resolve organization context
  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Transfer Token]",
    "transfer-token"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const { organizationId, userId } = orgCtx;

  // Stablecoin ceiling. An ERC-20 transfer carries a native value of 0, so the
  // daily value cap reserves nothing for it and cannot see it at all. Checked
  // here rather than in the calling route so every entrance is covered: the
  // direct transfer API, the node-execution API, and the workflow step.
  const stablecoinCap = await checkStablecoinTransferAmount({
    organizationId,
    chainId,
    tokenAddress,
    amount,
    context: "transfer-token",
  });
  if (stablecoinCap.kind !== "allowed") {
    // Same classification as writeContractCore's identical refusal. Without it
    // the two cores file the same policy denial under different fault domains
    // in the metrics, so the deny rate cannot be read across them.
    return {
      success: false,
      error: stablecoinCap.error,
      errorClass: ExecutionErrorType.USER,
    };
  }

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
      "[Transfer Token] Failed to resolve RPC config",
      error,
      {
        plugin_name: "web3",
        action_name: "transfer-token",
        chain_id: String(chainId),
      }
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

  // Get workflow ID for transaction tracking. The executor already puts
  // workflowId directly on _context for every real workflow execution, so
  // only fall back to a DB lookup when a caller supplies executionId
  // without it. The organizationId check matters separately: a direct
  // execution (app/api/execute/node/route.ts) sets both executionId and
  // organizationId but its executionId is not a workflowExecutions row, so
  // without this guard every direct execution fires a lookup that can never
  // return anything.
  let workflowId: string | undefined = _context.workflowId;
  if (!workflowId && _context.executionId && !_context.organizationId) {
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
      // `amount` is in the units the holder is shown. On an ERC-8056 token
      // those are UI units and `transfer` takes raw ones, so convert down.
      // Identity for every ordinary ERC-20. Refuses rather than guessing: an
      // unscaled fallback here would move several times the intended amount.
      const multiplier = await resolveForWrite(
        (op) => rpcManager.executeWithFailover(op),
        chainId,
        tokenAddress
      );
      if (!multiplier.ok) {
        return { success: false, error: getErrorMessage(multiplier.error) };
      }
      const converted = convertAmountForWrite(
        ethers.parseUnits(amount, Number(decimals)),
        multiplier.multiplier
      );
      if (!converted.ok) {
        return { success: false, error: converted.error };
      }
      const amountRaw = converted.raw;

      const sponsoredResult = await executeSponsoredContractTransaction({
        organizationId,
        executionId: _context.executionId ?? "direct-execution",
        chainId,
        rpcUrl,
        walletAddress,
        to: tokenAddress,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [recipientAddress, amountRaw],
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
          { target: tokenAddress, abi: ERC20_ABI, functionName: "transfer" }
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
          amount,
          symbol,
          recipient: recipientAddress,
          executedCall,
        };
      }

      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Token] Sponsorship skipped (credits exhausted, chain unsupported, or client creation failed), falling back to direct signing",
        undefined,
        {
          plugin_name: "web3",
          action_name: "transfer-token",
          chain_id: String(chainId),
        }
      );
    } catch (error) {
      const decision = resolveSponsoredSendError(error, {
        logPrefix: "[Transfer Token]",
        actionName: "transfer-token",
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

  // Answer gas affordability before queueing on the wallet's nonce lock. A
  // holder that cannot pay would otherwise take the lock, spend a full failover
  // round discovering that at broadcast, and stall every other execution for
  // the same wallet behind it. The ERC-20 balance check above covers the token
  // side; this one covers the native gas the transfer still has to pay for.
  const gasCheck = await preflightGasBalance({
    rpcManager,
    chainId,
    holderAddress: resolveFundingHolder(signerMode, walletAddress),
  });
  if (!gasCheck.affordable) {
    return { success: false, error: gasCheck.message };
  }

  return withNonceSession(txContext, walletAddress, async (session) => {
    // Initialize wallet signer
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    let signerAddress: string;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl, chainId);
      signerAddress = await signer.getAddress();
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Create contract instance for the actual write (needs signer)
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    try {
      const tokenHolderAddress =
        signerMode.kind === SIGNER_MODE.SAFE_ROLE || signerMode.kind === SIGNER_MODE.SAFE
          ? signerMode.safeAddress
          : signerAddress;

      const [decimals, symbol, balance] =
        await rpcManager.executeWithFailover((p) => {
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, p);
          return Promise.all([
            tokenContract.decimals() as Promise<bigint>,
            tokenContract.symbol() as Promise<string>,
            tokenContract.balanceOf(tokenHolderAddress) as Promise<bigint>,
          ]);
        });

      const decimalsNum = Number(decimals);

      // `amount` is in the units the holder is shown. On an ERC-8056 token
      // those are UI units and `transfer` takes raw ones, so the typed amount
      // converts down and the on-chain balance converts up before the two are
      // compared. Identity for every ordinary ERC-20. Refuses rather than
      // guessing: an unscaled fallback would move several times the ask.
      const multiplierResult = await resolveForWrite(
        (op) => rpcManager.executeWithFailover(op),
        chainId,
        tokenAddress
      );
      if (!multiplierResult.ok) {
        return {
          success: false,
          error: getErrorMessage(multiplierResult.error),
        };
      }
      const uiMultiplier = multiplierResult.multiplier;

      // Convert amount to raw units
      let amountRaw: bigint;
      try {
        const converted = convertAmountForWrite(
          ethers.parseUnits(amount, decimalsNum),
          uiMultiplier
        );
        if (!converted.ok) {
          return { success: false, error: converted.error };
        }
        amountRaw = converted.raw;
      } catch (error) {
        return {
          success: false,
          error: `Invalid amount format: ${getErrorMessage(error)}`,
        };
      }

      // Check balance before transfer
      if (balance < amountRaw) {
        // Report the shortfall in the same units the caller asked in, or the
        // message compares a UI figure against a raw one and reads as nonsense.
        const balanceFormatted = ethers.formatUnits(
          rawToUi(balance, uiMultiplier),
          decimalsNum
        );
        return {
          success: false,
          error: `Insufficient ${symbol} balance. Have: ${balanceFormatted}, Need: ${amount}`,
        };
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
            functionKey: "transfer",
            args: [recipientAddress, amountRaw],
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
            functionKey: "transfer",
            args: [recipientAddress, amountRaw],
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
            functionKey: "transfer",
            args: [recipientAddress, amountRaw],
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
        functionName: "transfer",
      });

      return {
        success: true,
        transactionHash: receipt.hash,
        chainId,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
        amount,
        symbol,
        recipient: recipientAddress,
        executedCall,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Token] Transaction failed",
        error,
        {
          plugin_name: "web3",
          action_name: "transfer-token",
          chain_id: String(chainId),
        }
      );
      const rejection = classifyRevert(error, contract.interface);
      // Attributed as a system fault so the execution log records a fault
      // domain for it; a relay-determined class is more specific, so it wins.
      const errorClass =
        rpcRelayErrorClass(error) ??
        (isOnChainPendingError(error) ? ExecutionErrorType.SYSTEM : undefined);
      return {
        success: false,
        error: formatContractError(
          error,
          contract.interface,
          "Token transfer failed"
        ),
        ...(errorClass ? { errorClass } : {}),
        ...(rejection.kind !== "unknown" ? { rejection } : {}),
        ...(broadcastTransactionHash(error)
          ? { transactionHash: broadcastTransactionHash(error), chainId }
          : {}),
      };
    }
  });
}
