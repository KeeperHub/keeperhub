import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { PROTOCOL_CATALOG } from "@/lib/safe/protocol-registry";
import {
  type DirectRuleInput,
  getSafeRoleWithBackfill,
  installRolesWithInitialConfig,
  type ProtocolInput,
  tokenAddressForWire,
} from "@/lib/safe/roles-orchestrator";
import type { DroppedInput } from "@/lib/safe/route-input";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type RouteParams = { params: Promise<{ safeId: string }> };

type InstallBodyTokenEntry = {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  amountHuman?: string;
  periodSeconds?: number;
};

type InstallBodyDirectRule = {
  kind?: "erc20-transfer" | "erc20-approve" | "native-transfer";
  tokenAddress?: string | null;
  tokenSymbol?: string;
  tokenDecimals?: number;
  counterparty?: string;
  amountHuman?: string;
  periodSeconds?: number;
};

type InstallBody = {
  protocols?: Array<
    | string
    | {
        slug?: string;
        tokens?: InstallBodyTokenEntry[];
      }
  >;
  directRules?: InstallBodyDirectRule[];
  allowedTokenSymbols?: string[];
  allowances?: Array<{
    tokenAddress: string;
    maxRefillWei: string;
    refillWei: string;
    periodSeconds: number;
  }>;
};

function normaliseDirectRules(body: InstallBody): {
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
 * Accept both the new `{ protocols: ProtocolInput[] }` shape and the legacy
 * `{ protocols: string[], allowedTokenSymbols, allowances }` shape while the
 * wizard UI is migrating. Returns the normalised protocol list plus any
 * slug that was dropped because it is not in the catalog.
 */
function normaliseInstallBody(body: InstallBody): {
  protocols: ProtocolInput[];
  skipped: string[];
  dropped: DroppedInput[];
} {
  const raw = body.protocols ?? [];
  const skipped: string[] = [];
  const dropped: DroppedInput[] = [];

  const looksLikeNewShape =
    raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null;

  if (looksLikeNewShape) {
    const protocols: ProtocolInput[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        continue;
      }
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
      protocols.push({ slug, tokens });
    }
    return { protocols, skipped, dropped };
  }

  const legacySlugs = raw.filter(
    (entry): entry is string => typeof entry === "string"
  );
  const legacySymbols = body.allowedTokenSymbols ?? [];
  const legacyAllowances = body.allowances ?? [];
  const tokens = legacyAllowances.map((a) => ({
    tokenAddress: a.tokenAddress,
    tokenSymbol: legacySymbols[0] ?? "UNKNOWN",
    tokenDecimals: 18,
    amountHuman: a.maxRefillWei,
    periodSeconds: a.periodSeconds,
  }));
  const protocols: ProtocolInput[] = [];
  for (const slug of legacySlugs) {
    if (!(slug in PROTOCOL_CATALOG)) {
      skipped.push(slug);
      continue;
    }
    protocols.push({ slug, tokens });
  }
  return { protocols, skipped, dropped };
}

export async function GET(
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

    const { role, protocols, allowances, directRules } =
      await getSafeRoleWithBackfill(safe);
    if (!role) {
      return NextResponse.json({
        installed: false,
        role: null,
        protocols: [],
        allowances: [],
        directRules: [],
      });
    }

    return NextResponse.json({
      installed: true,
      role: {
        id: role.id,
        safeWalletId: role.safeWalletId,
        roleKey: role.roleKey,
        rolesModifierAddress: role.rolesModifierAddress,
        delegateAddress: role.delegateAddress,
        status: role.status,
        installedTxHash: role.installedTxHash,
        lastReconciledAt: role.lastReconciledAt,
        createdAt: role.createdAt,
      },
      protocols: protocols.map((p) => ({
        id: p.id,
        protocolSlug: p.protocolSlug,
        templateSlug: p.templateSlug,
        allowedTokenSymbols: p.allowedTokenSymbols,
        targetAddresses: p.targetAddresses,
        allowedSelectors: p.allowedSelectors,
        status: p.status,
        lastUpdatedAt: p.lastUpdatedAt,
      })),
      allowances: allowances.map((a) => ({
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
      directRules: directRules.map((r) => ({
        id: r.id,
        kind: r.kind,
        tokenAddress: tokenAddressForWire(r.tokenAddress),
        tokenSymbol: r.tokenSymbol,
        tokenDecimals: r.tokenDecimals,
        counterparty: r.counterparty,
        amountHuman: r.amountHuman,
        periodSeconds: r.periodSeconds,
        status: r.status,
        lastUpdatedAt: r.lastUpdatedAt,
      })),
    });
  } catch (error) {
    return apiError(error, "Failed to load Safe role state");
  }
}

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

    const body = (await request.json()) as InstallBody;
    const {
      protocols: perProtocol,
      skipped,
      dropped: droppedProtocols,
    } = normaliseInstallBody(body);
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

    if (perProtocol.length === 0 && directRules.length === 0) {
      return NextResponse.json(
        {
          error:
            "At least one protocol or direct rule must be configured to install the role",
        },
        { status: 400 }
      );
    }

    const result = await installRolesWithInitialConfig({
      organizationId: admin.organizationId,
      chainId: safe.chainId,
      protocols: perProtocol,
      directRules,
    });

    if (!result.success) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] Roles install failed org=${admin.organizationId} safe=${safe.id}`,
        new Error(result.error),
        {
          endpoint: "/api/user/safe/[safeId]/role",
          component: "safe-role-api",
          chain_id: safe.chainId.toString(),
        }
      );
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    await recordAuditEvent({
      actor: {
        userId: admin.userId,
        organizationId: admin.organizationId,
        authMethod: "session",
      },
      action: "safe_role.installed",
      resourceType: "safe",
      resourceId: safe.id,
      after: {
        chainId: safe.chainId,
        protocols: result.protocols.map((p) => p.protocolSlug),
        allowanceCount: result.allowances.length,
        directRuleCount: directRules.length,
        alreadyInstalled: result.alreadyInstalled,
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      success: true,
      alreadyInstalled: result.alreadyInstalled,
      role: {
        id: result.role.id,
        safeWalletId: result.role.safeWalletId,
        roleKey: result.role.roleKey,
        rolesModifierAddress: result.role.rolesModifierAddress,
        delegateAddress: result.role.delegateAddress,
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
        refillWei: a.refillWei,
        periodSeconds: a.periodSeconds,
      })),
      applied: result.applied,
      skipped: [...result.skipped, ...skipped],
      skippedDirectRules: result.skippedDirectRules,
    });
  } catch (error) {
    return apiError(error, "Failed to install Zodiac Roles");
  }
}
