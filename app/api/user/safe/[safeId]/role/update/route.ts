import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { PROTOCOL_CATALOG } from "@/lib/safe/protocol-registry";
import {
  type DirectRuleInput,
  type ProtocolInput,
  updateRolesConfig,
} from "@/lib/safe/roles-orchestrator";
import type { DroppedInput } from "@/lib/safe/route-input";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import type { DirectRuleBody, TokenLimitBody } from "../../../_lib/role-body";

type RouteParams = { params: Promise<{ safeId: string }> };

type UpdateBody = {
  protocols?: Array<{
    slug?: string;
    tokens?: TokenLimitBody[];
  }>;
  directRules?: DirectRuleBody[];
  /**
   * Opt-in flag required to apply an empty desired state (which would
   * revoke every protocol scope and zero every allowance bucket). Defense
   * against a UI bug or partner integration that accidentally serializes
   * `{}` against a non-empty role.
   */
  confirm?: string;
};

const WIPE_CONFIRM_TOKEN = "remove-all-policies";

function normaliseProtocols(body: UpdateBody): {
  protocols: ProtocolInput[];
  skipped: string[];
  dropped: DroppedInput[];
} {
  const skipped: string[] = [];
  const dropped: DroppedInput[] = [];
  const out: ProtocolInput[] = [];
  for (const entry of body.protocols ?? []) {
    const slug = entry?.slug;
    if (!slug) {
      continue;
    }
    if (!(slug in PROTOCOL_CATALOG)) {
      skipped.push(slug);
      continue;
    }
    const tokens: ProtocolInput["tokens"] = [];
    const rawTokens = entry.tokens ?? [];
    for (const [tokenIndex, t] of rawTokens.entries()) {
      if (
        !(t.tokenAddress && t.tokenSymbol) ||
        typeof t.tokenDecimals !== "number" ||
        !t.amountHuman ||
        typeof t.periodSeconds !== "number"
      ) {
        dropped.push({
          category: "protocol-token",
          protocolSlug: slug,
          tokenIndex,
          reason:
            "Missing one of: tokenAddress, tokenSymbol, tokenDecimals, amountHuman, periodSeconds",
        });
        continue;
      }
      tokens.push({
        tokenAddress: t.tokenAddress,
        tokenSymbol: t.tokenSymbol,
        tokenDecimals: t.tokenDecimals,
        amountHuman: t.amountHuman,
        periodSeconds: t.periodSeconds,
      });
    }
    out.push({ slug, tokens });
  }
  return { protocols: out, skipped, dropped };
}

function normaliseDirectRules(body: UpdateBody): {
  values: DirectRuleInput[];
  dropped: DroppedInput[];
} {
  const values: DirectRuleInput[] = [];
  const dropped: DroppedInput[] = [];
  const rules = body.directRules ?? [];
  for (const [index, rule] of rules.entries()) {
    if (
      !(rule.kind && rule.counterparty && rule.amountHuman && rule.tokenSymbol)
    ) {
      dropped.push({
        category: "direct-rule",
        index,
        reason: "Missing one of: kind, counterparty, amountHuman, tokenSymbol",
      });
      continue;
    }
    if (
      typeof rule.tokenDecimals !== "number" ||
      typeof rule.periodSeconds !== "number"
    ) {
      dropped.push({
        category: "direct-rule",
        index,
        reason: "tokenDecimals and periodSeconds must be numbers",
      });
      continue;
    }
    values.push({
      kind: rule.kind,
      tokenAddress: rule.tokenAddress ?? null,
      tokenSymbol: rule.tokenSymbol,
      tokenDecimals: rule.tokenDecimals,
      counterparty: rule.counterparty,
      amountHuman: rule.amountHuman,
      periodSeconds: rule.periodSeconds,
    });
  }
  return { values, dropped };
}

/**
 * Apply a delta against an already-installed Zodiac Role. The body is the
 * FULL desired state (protocols + direct rules), not a patch -- the
 * orchestrator computes the diff internally so the client can just submit
 * "what the policies should look like now."
 *
 * Direct rule REMOVAL is not supported here in this revision; use the
 * per-allowance Revoke button for ERC-20 direct rule buckets.
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

    const body = (await request.json()) as UpdateBody;
    const {
      protocols,
      skipped,
      dropped: droppedProtocols,
    } = normaliseProtocols(body);
    const { values: directRules, dropped: droppedDirectRules } =
      normaliseDirectRules(body);
    const droppedInputs: DroppedInput[] = [
      ...droppedProtocols,
      ...droppedDirectRules,
    ];
    if (droppedInputs.length > 0) {
      return NextResponse.json(
        {
          error:
            "Some entries were dropped due to missing or invalid fields. Fix and resubmit.",
          droppedInputs,
        },
        { status: 400 }
      );
    }

    if (
      protocols.length === 0 &&
      directRules.length === 0 &&
      body.confirm !== WIPE_CONFIRM_TOKEN
    ) {
      return NextResponse.json(
        {
          error: `Refusing to apply empty policy set. Pass confirm: "${WIPE_CONFIRM_TOKEN}" to revoke all current protocols and allowances.`,
        },
        { status: 400 }
      );
    }

    const result = await updateRolesConfig({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
      protocols,
      directRules,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Roles update failed org=${admin.organizationId} safe=${safe.id}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/role/update",
          component: "safe-role-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    if (!result.noChanges) {
      await recordAuditEvent({
        actor: {
          userId: admin.userId,
          organizationId: admin.organizationId,
          authMethod: "session",
        },
        action: "safe_role.updated",
        resourceType: "safe",
        resourceId: safe.id,
        after: {
          chainId: safe.chainId,
          addedProtocols: result.addedProtocols,
          removedProtocols: result.removedProtocols,
          addedAllowances: result.addedAllowances,
          changedAllowances: result.changedAllowances,
          revokedAllowances: result.revokedAllowances,
        },
        metadata: buildAuditMetadata(request),
      });
    }

    return NextResponse.json({
      success: true,
      noChanges: result.noChanges,
      addedProtocols: result.addedProtocols,
      removedProtocols: result.removedProtocols,
      addedAllowances: result.addedAllowances,
      changedAllowances: result.changedAllowances,
      revokedAllowances: result.revokedAllowances,
      role: {
        id: result.role.id,
        rolesModifierAddress: result.role.rolesModifierAddress,
        status: result.role.status,
      },
      protocols: result.protocols.map((p) => ({
        id: p.id,
        protocolSlug: p.protocolSlug,
        status: p.status,
      })),
      allowances: result.allowances.map((a) => ({
        id: a.id,
        protocolSlug: a.protocolSlug,
        tokenAddress: a.tokenAddress,
        tokenSymbol: a.tokenSymbol,
        maxRefillWei: a.maxRefillWei,
        periodSeconds: a.periodSeconds,
      })),
      applied: result.applied,
      skipped: [...result.skipped, ...skipped],
      skippedDirectRules: result.skippedDirectRules,
    });
  } catch (error) {
    return apiError(error, "Failed to update Zodiac Roles configuration");
  }
}
