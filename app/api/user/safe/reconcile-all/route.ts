import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { validateSafeAdmin } from "@/lib/safe/auth";
import { reconcileSafeWalletsAllChains } from "@/lib/safe/deployment";

/**
 * Sweep every supported chain for the active org, probe the deterministic
 * Safe address, and adopt into the DB any Safe that exists on chain but
 * isn't yet recorded.
 *
 * Closes the "Safe deployed on chain but DB write dropped" hole that today
 * surfaces as `Create2 call failed` on the next deploy attempt. Same
 * shape as `/role/reconcile` but for Safe wallets themselves rather than
 * the role-modifier policies.
 *
 * Admin-gated -- adopting Safes changes the org's available routing for
 * workflow writes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const outcomes = await reconcileSafeWalletsAllChains({
      organizationId: admin.organizationId,
    });

    // Roll up the role-reconcile results too so the UI can show a single
    // "synced X Safes / Y policy sets" toast instead of two round trips.
    const safeOutcomes = outcomes.filter(
      (o) => o.status === "adopted" || o.status === "already-in-db"
    );
    const rolesSynced = safeOutcomes.filter(
      (o) => "role" in o && o.role.status === "synced"
    ).length;
    const rolesNotInstalled = safeOutcomes.filter(
      (o) => "role" in o && o.role.status === "no-role-installed"
    ).length;
    const rolesFailed = safeOutcomes.filter(
      (o) => "role" in o && o.role.status === "failed"
    ).length;

    const summary = {
      adopted: outcomes.filter((o) => o.status === "adopted").length,
      alreadyInDb: outcomes.filter((o) => o.status === "already-in-db").length,
      noOnchainSafe: outcomes.filter((o) => o.status === "no-onchain-safe")
        .length,
      failed: outcomes.filter((o) => o.status === "failed").length,
      rolesSynced,
      rolesNotInstalled,
      rolesFailed,
    };

    if (summary.failed > 0) {
      const failures = outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({
          chainId: o.chainId,
          error: "error" in o ? o.error : "unknown",
        }));
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] reconcile-all partial failure for org=${admin.organizationId}`,
        new Error(JSON.stringify(failures)),
        { component: "safe-reconcile-all" }
      );
    }

    return NextResponse.json({
      success: true,
      summary,
      outcomes,
    });
  } catch (error) {
    return apiError(error, "Failed to reconcile Safe wallets from chain");
  }
}
