import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  chains,
  safeRoleAllowances,
  safeRoleProtocols,
  safeRoles,
} from "@/lib/db/schema";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
import { getSafeForOrg, validateSafeAdmin } from "@/lib/safe/auth";
import { TEMPLATE_SPECS } from "@/lib/safe/condition-templates";
import { formatPeriod, formatTokenAmount } from "@/lib/safe/format-allowance";
import { getNativeUsdPrice, weiToUsd } from "@/lib/safe/price-oracle";
import {
  PROTOCOL_CATALOG,
  type ProtocolSlug,
} from "@/lib/safe/protocol-registry";
import { getProtocolTargets } from "@/lib/safe/protocol-targets";
import {
  type DirectRuleInput,
  flattenInstallInput,
  type ProtocolInput,
} from "@/lib/safe/roles-orchestrator";
import type { DroppedInput } from "@/lib/safe/route-input";
import {
  type DirectRuleBody,
  GAS_ASSIGN_ROLES,
  GAS_DEPLOY_MODULE,
  GAS_ENABLE_MODULE,
  GAS_OUTER_WRAPPER,
  GAS_SCOPE_FUNCTION,
  GAS_SCOPE_TARGET,
  GAS_SET_ALLOWANCE,
  GAS_SET_DEFAULT_ROLE,
  type OperationSummary,
  type TokenLimitBody,
} from "../../../_lib/role-body";

/**
 * Simulation endpoint used by the install / upgrade UI to show "you are about
 * to submit N transactions, roughly M gas, ~$X in fees".
 *
 * For a first-time install the Zodiac Roles proxy doesn't exist yet, so we
 * can't run estimateGas on the actual calldata. Instead we compute a
 * heuristic estimate from the operation mix: each sub-call within the
 * install MultiSend has a fairly tight gas distribution based on
 * operation type, and we err on the high side so the UI doesn't
 * under-promise.
 *
 * Returns a structured breakdown so the UI can render:
 *   - A list of "you will do X" lines (human-readable)
 *   - The raw gas units + priced estimate in native + USD
 *   - applied / skipped mirroring the install response
 */

type SimulateBody = {
  protocols?: Array<
    | string
    | {
        slug?: string;
        tokens?: TokenLimitBody[];
      }
  >;
  directRules?: DirectRuleBody[];
  allowedTokenSymbols?: string[];
  allowances?: Array<{
    tokenAddress?: string;
    maxRefillWei?: string;
    refillWei?: string;
    periodSeconds?: number;
  }>;
};

/**
 * Accept both the new `{ protocols: ProtocolInput[] }` shape and the legacy
 * `{ protocols: string[], allowedTokenSymbols, allowances }` shape so the
 * simulate endpoint stays usable while the wizard UI is migrating.
 */
function normaliseBody(body: SimulateBody): {
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

  const tokens = legacyAllowances.flatMap((a) => {
    if (!(a.tokenAddress && a.maxRefillWei && a.periodSeconds)) {
      return [];
    }
    return [
      {
        tokenAddress: a.tokenAddress,
        tokenSymbol: legacySymbols[0] ?? "UNKNOWN",
        tokenDecimals: 18,
        amountHuman: a.maxRefillWei,
        periodSeconds: a.periodSeconds,
      },
    ];
  });

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ safeId: string }> }
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
      return NextResponse.json({ error: "Safe not found" }, { status: 404 });
    }

    const body = (await request.json()) as SimulateBody;
    const {
      protocols: protocolInputs,
      skipped,
      dropped: droppedProtocols,
    } = normaliseBody(body);
    const directRulesInput: DirectRuleInput[] = [];
    const droppedDirectRules: DroppedInput[] = [];
    const rawDirectRules = body.directRules ?? [];
    for (const [index, rule] of rawDirectRules.entries()) {
      if (
        !(
          rule.kind &&
          rule.counterparty &&
          rule.amountHuman &&
          rule.tokenSymbol
        )
      ) {
        droppedDirectRules.push({
          category: "direct-rule",
          index,
          reason:
            "Missing one of: kind, counterparty, amountHuman, tokenSymbol",
        });
        continue;
      }
      if (
        typeof rule.tokenDecimals !== "number" ||
        typeof rule.periodSeconds !== "number"
      ) {
        droppedDirectRules.push({
          category: "direct-rule",
          index,
          reason: "tokenDecimals and periodSeconds must be numbers",
        });
        continue;
      }
      directRulesInput.push({
        kind: rule.kind,
        tokenAddress: rule.tokenAddress ?? null,
        tokenSymbol: rule.tokenSymbol,
        tokenDecimals: rule.tokenDecimals,
        counterparty: rule.counterparty,
        amountHuman: rule.amountHuman,
        periodSeconds: rule.periodSeconds,
      });
    }
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

    let tokenAllowances: ReturnType<typeof flattenInstallInput>["allowances"] =
      [];
    try {
      const flattened = flattenInstallInput(protocolInputs, directRulesInput);
      tokenAllowances = flattened.allowances;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid amount input" },
        { status: 400 }
      );
    }

    // If a role is already installed for this Safe, switch to update mode:
    // skip the one-shot install operations (deploy / enable / assign /
    // setDefault) and only show the diff against current state. Otherwise
    // emit the full install plan.
    const existingRoleRow = await db
      .select({
        id: safeRoles.id,
        rolesModifierAddress: safeRoles.rolesModifierAddress,
        status: safeRoles.status,
      })
      .from(safeRoles)
      .where(
        and(
          eq(safeRoles.safeWalletId, safe.id),
          eq(safeRoles.roleType, "automation")
        )
      )
      .limit(1);
    const isUpdate =
      existingRoleRow[0] !== undefined &&
      existingRoleRow[0].status === "active";

    const operations: OperationSummary[] = [];
    let totalGas = BigInt(0);

    if (!isUpdate) {
      operations.push({
        label: "Deploy Zodiac Roles modifier",
        detail:
          "Deploys a fresh Roles proxy owned by the Safe via the canonical ModuleProxyFactory.",
        gasUnits: GAS_DEPLOY_MODULE.toString(),
      });
      totalGas += GAS_DEPLOY_MODULE;

      operations.push({
        label: "Enable module on Safe",
        detail:
          "safe.enableModule(rolesModifier) authorises the modifier to call execTransactionFromModule.",
        gasUnits: GAS_ENABLE_MODULE.toString(),
      });
      totalGas += GAS_ENABLE_MODULE;

      operations.push({
        label: "Assign automation role to Turnkey EOA",
        detail: "rolesModifier.assignRoles(delegate, [roleKey], [true])",
        gasUnits: GAS_ASSIGN_ROLES.toString(),
      });
      totalGas += GAS_ASSIGN_ROLES;

      operations.push({
        label: "Set default role for delegate",
        detail: "rolesModifier.setDefaultRole(delegate, roleKey)",
        gasUnits: GAS_SET_DEFAULT_ROLE.toString(),
      });
      totalGas += GAS_SET_DEFAULT_ROLE;
    }

    // Determine which protocols are NEW vs already on chain. In install
    // mode, "new" = every desired protocol. In update mode, "new" = the
    // delta against the cached protocol rows so we don't double-count the
    // gas for ones that are already installed.
    let alreadyAppliedSlugs = new Set<string>();
    let alreadyAppliedAllowanceKeys = new Set<string>();
    if (isUpdate && existingRoleRow[0]) {
      const existingProtocols = await db
        .select({
          protocolSlug: safeRoleProtocols.protocolSlug,
          status: safeRoleProtocols.status,
        })
        .from(safeRoleProtocols)
        .where(eq(safeRoleProtocols.roleId, existingRoleRow[0].id));
      alreadyAppliedSlugs = new Set(
        existingProtocols
          .filter((p) => p.status === "allowed")
          .map((p) => p.protocolSlug)
      );
      const existingAllowances = await db
        .select({
          protocolSlug: safeRoleAllowances.protocolSlug,
          tokenAddress: safeRoleAllowances.tokenAddress,
        })
        .from(safeRoleAllowances)
        .where(eq(safeRoleAllowances.roleId, existingRoleRow[0].id));
      // Structural key: `<slug>|<lowercaseAddress>`. Matches the predicate
      // used below in `newOrChangedAllowances.filter`. The orchestrator's
      // diff path keys by the on-chain `tokenAllowanceKey` hash; this
      // route stays tuple-based to avoid recomputing the role key.
      alreadyAppliedAllowanceKeys = new Set(
        existingAllowances.map(
          (a) => `${a.protocolSlug}|${a.tokenAddress.toLowerCase()}`
        )
      );
    }

    const applied: string[] = [];
    const newlyApplied: string[] = [];
    let totalFunctionScopings = 0;
    let totalTargetScopings = 0;
    for (const p of protocolInputs) {
      const catalog = PROTOCOL_CATALOG[p.slug as ProtocolSlug];
      if (!catalog) {
        skipped.push(p.slug);
        continue;
      }
      const template = TEMPLATE_SPECS[catalog.templateSlug];
      if (!template) {
        skipped.push(p.slug);
        continue;
      }
      applied.push(p.slug);
      // Skip gas accounting for protocols already on chain. The orchestrator's
      // diff path will emit zero or near-zero calls for these because the SDK's
      // callsPlannedForApplyRole sees them as no-ops.
      if (alreadyAppliedSlugs.has(p.slug)) {
        continue;
      }
      newlyApplied.push(p.slug);
      if (catalog.enforcementLevel === "contract-allowlist") {
        const targets = getProtocolTargets(
          p.slug as ProtocolSlug,
          safe.chainId
        );
        totalTargetScopings += targets.length;
      } else {
        const approxTargets = 2;
        const approxFunctionsPerTarget = 4;
        totalTargetScopings += approxTargets;
        totalFunctionScopings += approxTargets * approxFunctionsPerTarget;
      }
    }

    if (directRulesInput.length > 0) {
      let directGas = BigInt(0);
      for (const rule of directRulesInput) {
        if (rule.kind === "native-transfer") {
          directGas += GAS_SCOPE_TARGET;
        } else {
          directGas += GAS_SCOPE_FUNCTION;
        }
      }
      operations.push({
        label: `Scope ${directRulesInput.length} direct rule${directRulesInput.length === 1 ? "" : "s"}`,
        detail: directRulesInput
          .map((r) => {
            const target =
              r.kind === "native-transfer"
                ? r.counterparty
                : (r.tokenAddress ?? "?");
            const truncated = `${target.slice(0, 6)}...${target.slice(-4)}`;
            return `${r.kind} on ${truncated} (${r.tokenSymbol}, cap ${r.amountHuman} every ${r.periodSeconds}s)`;
          })
          .join("; "),
        gasUnits: directGas.toString(),
      });
      totalGas += directGas;
    }

    if (totalTargetScopings > 0 || totalFunctionScopings > 0) {
      const scopeDetail =
        totalFunctionScopings > 0
          ? `~${totalTargetScopings} target allowlistings + ~${totalFunctionScopings} function scopings with parameter conditions (recipient, token allowlist, amount within allowance).`
          : `~${totalTargetScopings} target-level allowlistings (no per-function conditions on these protocols).`;
      const label = isUpdate
        ? `Scope ${newlyApplied.length} new protocol${newlyApplied.length === 1 ? "" : "s"}`
        : `Scope ${newlyApplied.length} protocol${newlyApplied.length === 1 ? "" : "s"}`;
      operations.push({
        label,
        detail: scopeDetail,
        gasUnits: (
          BigInt(totalTargetScopings) * GAS_SCOPE_TARGET +
          BigInt(totalFunctionScopings) * GAS_SCOPE_FUNCTION
        ).toString(),
      });
      totalGas +=
        BigInt(totalTargetScopings) * GAS_SCOPE_TARGET +
        BigInt(totalFunctionScopings) * GAS_SCOPE_FUNCTION;
    }

    // Allowance accounting: in update mode show only the buckets that need a
    // new setAllowance call (added or changed). Buckets already on chain at
    // the same cap+period get zero gas.
    const newOrChangedAllowances = tokenAllowances.filter((a) => {
      if (!isUpdate) {
        return true;
      }
      // The diff path keys allowances by tokenAllowanceKey, but the simulate
      // route doesn't have the roleKey in scope. Fall back to a structural
      // match by (protocolSlug, tokenAddress) -- if the bucket exists in DB
      // we conservatively skip it; the orchestrator does the precise diff
      // at execution time.
      return !alreadyAppliedAllowanceKeys.has(
        `${a.protocolSlug}|${a.tokenAddress.toLowerCase()}`
      );
    });
    if (newOrChangedAllowances.length > 0) {
      const label = isUpdate
        ? `Set ${newOrChangedAllowances.length} new token allowance${newOrChangedAllowances.length === 1 ? "" : "s"}`
        : `Set ${newOrChangedAllowances.length} token allowance${newOrChangedAllowances.length === 1 ? "" : "s"}`;
      operations.push({
        label,
        detail: newOrChangedAllowances
          .map((a) => {
            const cap = formatTokenAmount(a.maxRefillWei, a.tokenDecimals);
            const truncated = `${a.tokenAddress.slice(0, 6)}...${a.tokenAddress.slice(-4)}`;
            return `${a.tokenSymbol} (${truncated}): cap ${cap} ${a.tokenSymbol} ${formatPeriod(a.periodSeconds)}`;
          })
          .join("; "),
        gasUnits: (
          BigInt(newOrChangedAllowances.length) * GAS_SET_ALLOWANCE
        ).toString(),
      });
      totalGas += BigInt(newOrChangedAllowances.length) * GAS_SET_ALLOWANCE;
    }

    totalGas += GAS_OUTER_WRAPPER;

    const [chainRow] = await db
      .select({ name: chains.name })
      .from(chains)
      .where(eq(chains.chainId, safe.chainId))
      .limit(1);

    let maxFeePerGasWei = BigInt(25_000_000_000);
    try {
      const rpcUrl = getRpcUrlByChainId(safe.chainId, "primary");
      const manager = await getRpcProviderFromUrls(
        rpcUrl,
        undefined,
        safe.chainId
      );
      const feeData = await manager.getProvider().getFeeData();
      if (feeData.maxFeePerGas) {
        maxFeePerGasWei = feeData.maxFeePerGas;
      } else if (feeData.gasPrice) {
        maxFeePerGasWei = feeData.gasPrice;
      }
    } catch {
      // use default
    }

    const totalCostWei = totalGas * maxFeePerGasWei;
    const totalCostNative = ethers.formatEther(totalCostWei);
    const [totalCostUsd, nativePriceUsd] = await Promise.all([
      weiToUsd({ chainId: safe.chainId, amountWei: totalCostWei }),
      getNativeUsdPrice(safe.chainId),
    ]);

    return NextResponse.json({
      safe: {
        id: safe.id,
        chainId: safe.chainId,
        chainName: chainRow?.name ?? `chain-${safe.chainId}`,
        safeAddress: safe.safeAddress,
      },
      plan: {
        operations,
        totalGasUnits: totalGas.toString(),
        maxFeePerGasWei: maxFeePerGasWei.toString(),
        totalCostWei: totalCostWei.toString(),
        totalCostNative,
        totalCostUsd,
        nativePriceUsd,
        note: "Estimate is heuristic (operation-count times typical cost per operation). Actual gas will vary by ~20%.",
      },
      applied,
      skipped,
      allowances: tokenAllowances.map((a) => ({
        protocolSlug: a.protocolSlug,
        tokenAddress: a.tokenAddress,
        tokenSymbol: a.tokenSymbol,
        tokenDecimals: a.tokenDecimals,
        maxRefillWei: a.maxRefillWei,
        refillWei: a.refillWei,
        periodSeconds: a.periodSeconds,
      })),
    });
  } catch (error) {
    return apiError(error, "Failed to simulate policy install");
  }
}
