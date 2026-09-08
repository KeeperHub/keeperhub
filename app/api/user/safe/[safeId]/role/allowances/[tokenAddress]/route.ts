import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeOwner } from "@/lib/safe/auth";
import { PROTOCOL_CATALOG } from "@/lib/safe/protocol-registry";
import {
  DIRECT_RULE_PROTOCOL_SLUG,
  revokeRoleTokenAllowance,
} from "@/lib/safe/roles-orchestrator";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

// Slugs that may key an allowance bucket: any known protocol plus the
// synthetic "direct" slug used by per-rule (transfer/approve) caps.
const ALLOWED_ALLOWANCE_SLUGS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(PROTOCOL_CATALOG),
  DIRECT_RULE_PROTOCOL_SLUG,
]);

type RouteParams = {
  params: Promise<{ safeId: string; tokenAddress: string }>;
};

export async function DELETE(
  request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    // Authenticate first: don't leak route-shape (specific 400 messages
    // about token-address validity or required protocolSlug) to
    // unauthenticated probes. Review #923-r3 LOW.
    //
    // Owner-only by design: revoking a single on-chain allowance bucket
    // is destructive. Admins can view + edit but only the org owner can
    // revoke. The UI pairs the 403 with a tooltip on the disabled control.
    const owner = await validateSafeOwner(request);
    if ("error" in owner) {
      return NextResponse.json(
        { error: owner.error },
        { status: owner.status }
      );
    }

    const { safeId, tokenAddress } = await params;
    if (!ethers.isAddress(tokenAddress)) {
      return NextResponse.json(
        { error: `Invalid token address: ${tokenAddress}` },
        { status: 400 }
      );
    }

    const url = new URL(request.url);
    const protocolSlug = url.searchParams.get("protocolSlug");
    if (!protocolSlug) {
      return NextResponse.json(
        { error: "protocolSlug query parameter is required" },
        { status: 400 }
      );
    }
    if (!ALLOWED_ALLOWANCE_SLUGS.has(protocolSlug)) {
      return NextResponse.json(
        { error: `Unknown protocolSlug: ${protocolSlug}` },
        { status: 400 }
      );
    }

    const safe = await getSafeForOrg({
      safeId,
      organizationId: owner.organizationId,
    });
    if (!safe) {
      return NextResponse.json({ error: "Safe not found" }, { status: 404 });
    }

    const result = await revokeRoleTokenAllowance({
      organizationId: owner.organizationId,
      chainId: safe.chainId,
      protocolSlug,
      tokenAddress,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Revoke role allowance failed safe=${safe.id} token=${tokenAddress}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/role/allowances/[tokenAddress]",
          component: "safe-role-allowances-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    await recordAuditEvent({
      actor: {
        userId: owner.userId,
        organizationId: owner.organizationId,
        authMethod: "session",
      },
      action: "safe_role_allowance.revoked",
      resourceType: "safe",
      resourceId: safe.id,
      before: {
        protocolSlug,
        tokenAddress: result.deleted.tokenAddress,
        tokenSymbol: result.deleted.tokenSymbol,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      success: true,
      deleted: {
        id: result.deleted.id,
        tokenAddress: result.deleted.tokenAddress,
        tokenSymbol: result.deleted.tokenSymbol,
      },
    });
  } catch (error) {
    return apiError(error, "Failed to revoke Safe role allowance");
  }
}
