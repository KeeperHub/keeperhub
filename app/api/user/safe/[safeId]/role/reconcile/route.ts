import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { reconcileSafeRoleFromChain } from "@/lib/safe/roles-orchestrator";

type RouteParams = { params: Promise<{ safeId: string }> };

/**
 * Force a re-read of on-chain Roles modifier state and write the result
 * back to the cache tables. Used by the "Sync from chain" UI affordance and
 * also useful as a recovery hook when the orchestrator's post-tx DB write
 * dropped a row.
 */
export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const { safeId } = await params;
    const safe = await getSafeForOrg({
      safeId,
      organizationId: admin.organizationId,
    });
    if (!safe) {
      return NextResponse.json(
        { error: "Safe not found for this organization" },
        { status: 404 }
      );
    }

    const result = await reconcileSafeRoleFromChain(safe);
    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] reconcile route failed org=${admin.organizationId} safe=${safe.id}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/role/reconcile",
          component: "safe-role-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    if (!result.installed) {
      return NextResponse.json({
        installed: false,
        reason: result.reason,
      });
    }

    return NextResponse.json({
      installed: true,
      addedAllowances: result.addedAllowances,
      updatedAllowances: result.updatedAllowances,
      staleAllowances: result.staleAllowances,
      role: {
        id: result.role.id,
        safeWalletId: result.role.safeWalletId,
        roleKey: result.role.roleKey,
        rolesModifierAddress: result.role.rolesModifierAddress,
        delegateAddress: result.role.delegateAddress,
        status: result.role.status,
        lastReconciledAt: result.role.lastReconciledAt,
      },
      protocols: result.protocols.map((p) => ({
        id: p.id,
        protocolSlug: p.protocolSlug,
        templateSlug: p.templateSlug,
        allowedTokenSymbols: p.allowedTokenSymbols,
        targetAddresses: p.targetAddresses,
        allowedSelectors: p.allowedSelectors,
        status: p.status,
        lastUpdatedAt: p.lastUpdatedAt,
      })),
      allowances: result.allowances.map((a) => ({
        id: a.id,
        protocolSlug: a.protocolSlug,
        allowanceKey: a.allowanceKey,
        tokenAddress: a.tokenAddress,
        tokenSymbol: a.tokenSymbol,
        tokenDecimals: a.tokenDecimals,
        maxRefillWei: a.maxRefillWei,
        refillWei: a.refillWei,
        periodSeconds: a.periodSeconds,
        lastChainBalanceWei: a.lastChainBalanceWei,
        lastChainTimestamp: a.lastChainTimestamp,
        lastReconciledAt: a.lastReconciledAt,
        lastUpdatedAt: a.lastUpdatedAt,
      })),
    });
  } catch (error) {
    return apiError(error, "Failed to reconcile Safe role from chain");
  }
}
