import "server-only";

import { and, eq } from "drizzle-orm";
import type { ethers } from "ethers";
import { recordWalletInAddressBook } from "@/lib/address-book/record-wallet";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { chains, type SafeWallet, safeWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError, logUserError } from "@/lib/logging";
import { startSafeDeployMetrics } from "@/lib/metrics/instrumentation/safe";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import {
  buildCreateProxyCalldata,
  buildSetupCalldata,
  computeSafeProxyAddress,
  orgSaltNonce,
  parseProxyCreationEvent,
} from "@/lib/safe/address";
import {
  getSafeContracts,
  getSafeSingletonForDeploy,
  isSafeSupportedChain,
  SAFE_VERSION,
  SUPPORTED_SAFE_CHAIN_IDS,
} from "@/lib/safe/contracts";
import { formatSafeDeployError } from "@/lib/safe/deploy-errors";
import { generateId } from "@/lib/utils/id";
import {
  executeTransaction,
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";
import {
  getOrganizationWallet,
  initializeWalletSigner,
} from "@/lib/web3/wallet-helpers";

export type DeployOrgSafeInput = {
  organizationId: string;
  chainId: number;
  /**
   * Optional synthetic execution ID for telemetry/nonce tracking. When omitted
   * we mint one; there is no workflow behind a Safe deploy.
   */
  executionId?: string;
};

export type DeployOrgSafeResult =
  | {
      success: true;
      safe: SafeWallet;
      alreadyDeployed: boolean;
    }
  | { success: false; error: string };

async function findExistingSafe(
  organizationId: string,
  chainId: number
): Promise<SafeWallet | null> {
  const rows = await db
    .select()
    .from(safeWallets)
    .where(
      and(
        eq(safeWallets.organizationId, organizationId),
        eq(safeWallets.chainId, chainId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

async function chainIsEnabled(chainId: number): Promise<boolean> {
  const [row] = await db
    .select({ isEnabled: chains.isEnabled, chainType: chains.chainType })
    .from(chains)
    .where(eq(chains.chainId, chainId))
    .limit(1);

  if (!row) {
    return false;
  }
  return row.chainType === "evm" && row.isEnabled === true;
}

function validateReceiptStatus(receipt: ethers.TransactionReceipt): void {
  if (receipt.status !== 1) {
    throw new Error(
      `Safe deployment transaction reverted (status ${receipt.status})`
    );
  }
}

/**
 * Deploy a Safe smart account for an organization on the given chain.
 *
 * Idempotent: if a safe_wallets row already exists for (org, chain) the
 * existing row is returned and no tx is sent. The Safe is initialised with
 * the org's active EOA (Turnkey/Para) as sole owner, threshold = 1.
 */
export async function deployOrgSafe(
  input: DeployOrgSafeInput
): Promise<DeployOrgSafeResult> {
  const { organizationId, chainId } = input;
  const finishMetrics = startSafeDeployMetrics(chainId);

  if (!isSafeSupportedChain(chainId)) {
    finishMetrics("failure");
    return {
      success: false,
      error: `Safe deployment is not supported on chain ${chainId}`,
    };
  }

  const enabled = await chainIsEnabled(chainId);
  if (!enabled) {
    finishMetrics("failure");
    return {
      success: false,
      error: `Chain ${chainId} is not enabled for deployment`,
    };
  }

  const existing = await findExistingSafe(organizationId, chainId);
  if (existing && existing.status === "deployed") {
    finishMetrics("already_deployed");
    return { success: true, safe: existing, alreadyDeployed: true };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);

  const contracts = getSafeContracts(chainId);
  const singleton = getSafeSingletonForDeploy(chainId);
  const saltNonce = orgSaltNonce(organizationId, chainId);
  const initializer = buildSetupCalldata({
    owners: [ownerAddress],
    threshold: 1,
    fallbackHandler: contracts.compatibilityFallbackHandler,
  });
  const calldata = buildCreateProxyCalldata({
    singleton,
    initializer,
    saltNonce,
  });

  const rpcUrl = getRpcUrlByChainId(chainId, "primary");
  const rpcManager = await getRpcProviderFromUrls(rpcUrl, undefined, chainId);
  const executionId = input.executionId ?? `safe-deploy-${generateId()}`;

  const context: TransactionContext = {
    organizationId,
    executionId,
    chainId,
    rpcUrl,
    rpcManager,
  };

  // Pre-flight: if the deterministic CREATE2 address already has code,
  // adopt it instead of attempting createProxyWithNonce (which would revert
  // with `Create2 call failed`). Recovers from any half-applied prior
  // deploy where the on-chain tx confirmed but the DB write was lost.
  const predictedAddress = await rpcManager.executeWithFailover((provider) =>
    computeSafeProxyAddress({
      provider,
      factory: contracts.proxyFactory,
      singleton,
      initializer,
      saltNonce,
    })
  );
  const existingCode = await rpcManager.executeWithFailover((provider) =>
    provider.getCode(predictedAddress)
  );
  if (existingCode && existingCode !== "0x") {
    const normalizedSafeAddress = normalizeAddressForStorage(predictedAddress);
    const [adopted] = await db
      .insert(safeWallets)
      .values({
        organizationId,
        chainId,
        safeAddress: normalizedSafeAddress,
        ownerWalletId: ownerWallet.id,
        owners: [ownerAddress],
        threshold: 1,
        saltNonce: saltNonce.toString(),
        safeVersion: SAFE_VERSION,
        singletonAddress: normalizeAddressForStorage(singleton),
        factoryAddress: normalizeAddressForStorage(contracts.proxyFactory),
        deploymentTxHash: null,
        deploymentBlock: null,
        status: "deployed",
        deployedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    finishMetrics("already_deployed");
    if (adopted) {
      await recordWalletInAddressBook({
        organizationId,
        address: adopted.safeAddress,
        label: "Safe Wallet",
      });
      return { success: true, safe: adopted, alreadyDeployed: true };
    }
    // Race: another caller adopted between our findExistingSafe + insert.
    // Re-read and return that row.
    const refetched = await findExistingSafe(organizationId, chainId);
    if (refetched) {
      await recordWalletInAddressBook({
        organizationId,
        address: refetched.safeAddress,
        label: "Safe Wallet",
      });
      return { success: true, safe: refetched, alreadyDeployed: true };
    }
    return {
      success: false,
      error:
        "Adopted existing on-chain Safe but DB row insert race left no row",
    };
  }

  // Signer isn't used directly here (executeTransaction builds its own inside
  // the nonce session), but we call initializeWalletSigner early to surface a
  // clear error if the EOA is unreachable before acquiring the nonce lock.
  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  try {
    const result = await withNonceSession(context, ownerAddress, (session) =>
      executeTransaction(
        context,
        ownerAddress,
        () => ({
          to: contracts.proxyFactory,
          data: calldata,
          value: BigInt(0),
          chainId,
        }),
        session
      )
    );

    if (!(result.success && result.receipt)) {
      throw new Error(result.error ?? "Safe deployment failed");
    }

    validateReceiptStatus(result.receipt);
    const safeAddress = parseProxyCreationEvent(
      result.receipt,
      contracts.proxyFactory
    );

    const normalizedSafeAddress = normalizeAddressForStorage(safeAddress);

    const [inserted] = await db
      .insert(safeWallets)
      .values({
        organizationId,
        chainId,
        safeAddress: normalizedSafeAddress,
        ownerWalletId: ownerWallet.id,
        owners: [ownerAddress],
        threshold: 1,
        saltNonce: saltNonce.toString(),
        safeVersion: SAFE_VERSION,
        singletonAddress: normalizeAddressForStorage(singleton),
        factoryAddress: normalizeAddressForStorage(contracts.proxyFactory),
        deploymentTxHash: result.txHash,
        deploymentBlock: result.receipt.blockNumber,
        status: "deployed",
        deployedAt: new Date(),
      })
      .returning();

    await recordWalletInAddressBook({
      organizationId,
      address: inserted.safeAddress,
      label: "Safe Wallet",
    });

    finishMetrics("success");
    return { success: true, safe: inserted, alreadyDeployed: false };
  } catch (error) {
    finishMetrics("failure");
    const report = formatSafeDeployError(error);
    // Keep the full ethers CALL_EXCEPTION blob in Sentry for triage but
    // return a kind-classified user-readable message via the API. Raw
    // blobs are 1KB+ and unactionable in a toast. A deployer wallet with no
    // gas money is the one failure here that is not ours: it stays out of
    // Sentry so an unfunded wallet does not read as a platform fault. Every
    // other revert here (an adopted Safe, an unauthorized caller, a paused
    // contract) is still worth a look, so it keeps paging.
    const log =
      report.kind === "insufficient-gas" ? logUserError : logSystemError;
    log(
      ErrorCategory.TRANSACTION,
      `[Safe] Deployment failed for org=${organizationId}`,
      error,
      {
        component: "safe-deployment",
        chain_id: chainId.toString(),
      }
    );
    return {
      success: false,
      error: report.message,
    };
  }
}

export async function listOrgSafes(
  organizationId: string
): Promise<SafeWallet[]> {
  return await db
    .select()
    .from(safeWallets)
    .where(eq(safeWallets.organizationId, organizationId));
}

// ---------------------------------------------------------------------------
// Reconcile: pull authoritative state from chain for an org's deterministic
// Safe address(es).
//
// The deploy path can desync from chain in two ways:
//   - Half-applied deploy: the CREATE2 confirmed on chain but the post-tx
//     DB write dropped. Subsequent deploy attempts hit `Create2 call failed`
//     because the address is occupied.
//   - External deploy: the org-owner deployed a Safe at the deterministic
//     address via safe.global directly. KeeperHub never saw it.
//
// `reconcileSafeWalletForChain` checks the chain for code at the predicted
// address and adopts an existing Safe into the DB. `reconcileSafeWalletsAll`
// sweeps every supported chain at once.
// ---------------------------------------------------------------------------

/**
 * Per-Safe role-reconcile summary, mirroring what
 * `reconcileSafeRoleFromChain` writes back so the UI can show "policies
 * synced" alongside the wallet adoption. Kept narrow on purpose: we
 * don't need to re-export the full ReconcileSafeRoleResult union.
 */
export type SafeRoleReconcileSummary =
  | { status: "synced"; protocolsCount: number; allowancesCount: number }
  | { status: "no-role-installed" }
  | { status: "subgraph-unreachable" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

export type ReconcileSafeWalletOutcome =
  | {
      chainId: number;
      status: "adopted";
      safe: SafeWallet;
      role: SafeRoleReconcileSummary;
    }
  | {
      chainId: number;
      status: "already-in-db";
      safe: SafeWallet;
      role: SafeRoleReconcileSummary;
    }
  | { chainId: number; status: "no-onchain-safe" }
  | { chainId: number; status: "failed"; error: string };

export async function reconcileSafeWalletForChain(input: {
  organizationId: string;
  chainId: number;
}): Promise<ReconcileSafeWalletOutcome> {
  const { organizationId, chainId } = input;
  if (!isSafeSupportedChain(chainId)) {
    return {
      chainId,
      status: "failed",
      error: `Chain ${chainId} is not supported for Safe deployment`,
    };
  }

  try {
    const existing = await findExistingSafe(organizationId, chainId);
    if (existing && existing.status === "deployed") {
      // Safe is already tracked; still pull on-chain role state so the
      // policies / protocols / allowances cache catches up to whatever the
      // modifier currently reports.
      const role = await reconcileRoleForSafe(existing);
      return { chainId, status: "already-in-db", safe: existing, role };
    }

    const enabled = await chainIsEnabled(chainId);
    if (!enabled) {
      return {
        chainId,
        status: "failed",
        error: `Chain ${chainId} is not enabled`,
      };
    }

    const ownerWallet = await getOrganizationWallet(organizationId);
    const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
    const contracts = getSafeContracts(chainId);
    const singleton = getSafeSingletonForDeploy(chainId);
    const saltNonce = orgSaltNonce(organizationId, chainId);
    const initializer = buildSetupCalldata({
      owners: [ownerAddress],
      threshold: 1,
      fallbackHandler: contracts.compatibilityFallbackHandler,
    });

    const rpcUrl = getRpcUrlByChainId(chainId, "primary");
    const fallbackRpcUrl = getRpcUrlByChainId(chainId, "fallback");
    const rpcManager = await getRpcProviderFromUrls(
      rpcUrl,
      fallbackRpcUrl === rpcUrl ? undefined : fallbackRpcUrl,
      chainId
    );

    const predictedAddress = await rpcManager.executeWithFailover((provider) =>
      computeSafeProxyAddress({
        provider,
        factory: contracts.proxyFactory,
        singleton,
        initializer,
        saltNonce,
      })
    );
    const code = await rpcManager.executeWithFailover((provider) =>
      provider.getCode(predictedAddress)
    );
    if (!code || code === "0x") {
      return { chainId, status: "no-onchain-safe" };
    }

    const normalizedSafeAddress = normalizeAddressForStorage(predictedAddress);
    const [adopted] = await db
      .insert(safeWallets)
      .values({
        organizationId,
        chainId,
        safeAddress: normalizedSafeAddress,
        ownerWalletId: ownerWallet.id,
        owners: [ownerAddress],
        threshold: 1,
        saltNonce: saltNonce.toString(),
        safeVersion: SAFE_VERSION,
        singletonAddress: normalizeAddressForStorage(singleton),
        factoryAddress: normalizeAddressForStorage(contracts.proxyFactory),
        deploymentTxHash: null,
        deploymentBlock: null,
        status: "deployed",
        deployedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (adopted) {
      await recordWalletInAddressBook({
        organizationId,
        address: adopted.safeAddress,
        label: "Safe Wallet",
      });
      const role = await reconcileRoleForSafe(adopted);
      return { chainId, status: "adopted", safe: adopted, role };
    }
    const refetched = await findExistingSafe(organizationId, chainId);
    if (refetched) {
      await recordWalletInAddressBook({
        organizationId,
        address: refetched.safeAddress,
        label: "Safe Wallet",
      });
      const role = await reconcileRoleForSafe(refetched);
      return { chainId, status: "already-in-db", safe: refetched, role };
    }
    return {
      chainId,
      status: "failed",
      error: "Adopt insert lost the race and no row materialised",
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Reconcile failed for org=${organizationId} chain=${chainId}`,
      error,
      { component: "safe-deployment", chain_id: chainId.toString() }
    );
    return {
      chainId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function reconcileSafeWalletsAllChains(input: {
  organizationId: string;
}): Promise<ReconcileSafeWalletOutcome[]> {
  const { organizationId } = input;
  // Sequential rather than parallel: each chain hits a different RPC and
  // sequential makes failures easier to attribute. The list is bounded
  // (14 chains today) so the latency cost is acceptable.
  const outcomes: ReconcileSafeWalletOutcome[] = [];
  for (const chainId of SUPPORTED_SAFE_CHAIN_IDS) {
    const outcome = await reconcileSafeWalletForChain({
      organizationId,
      chainId,
    });
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Pull the Safe's role-modifier state (protocols, allowances, direct rules)
 * from chain into the DB cache via the orchestrator's reconcile path.
 *
 * Dynamic import on purpose: `roles-orchestrator` transitively pulls in
 * `defi-kit`, whose top-level proxy fans out across every chain's SDK at
 * module load and can recursively explode Next.js' page-data collector
 * if it ends up in deployment.ts's static import graph. Same dance
 * `signer-resolver.ts` does (see its file-top comment).
 */
async function reconcileRoleForSafe(
  safe: SafeWallet
): Promise<SafeRoleReconcileSummary> {
  try {
    const { reconcileSafeRoleFromChain } = await import(
      "@/lib/safe/roles-orchestrator"
    );
    const result = await reconcileSafeRoleFromChain(safe);
    if (!result.success) {
      return { status: "failed", error: result.error };
    }
    if (!result.installed) {
      return { status: "no-role-installed" };
    }
    if (result.subgraphUnreachable) {
      return { status: "subgraph-unreachable" };
    }
    return {
      status: "synced",
      protocolsCount: result.protocols.length,
      allowancesCount: result.allowances.length,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Role reconcile failed for safe=${safe.id}`,
      error,
      { component: "safe-deployment", chain_id: safe.chainId.toString() }
    );
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
