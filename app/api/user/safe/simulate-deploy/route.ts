import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import { validateSafeAdmin } from "@/lib/safe/auth";
import { TEMPLATE_SPECS } from "@/lib/safe/condition-templates";
import { isSafeSupportedChain } from "@/lib/safe/contracts";
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
import { buildFailoverRpcManager } from "@/lib/safe/rpc";
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
} from "../_lib/role-body";

/**
 * Pre-deploy simulation: tells the wizard what will land on chain when the
 * admin clicks "Deploy + install policies", before the Safe actually exists.
 *
 * Reuses the same heuristic gas accounting as the post-deploy install
 * simulator so the user sees a single coherent breakdown across the deploy
 * + install MultiSend.
 */

const GAS_DEPLOY_SAFE = BigInt(300_000);
const DEFAULT_GAS_PRICE_WEI = BigInt(25_000_000_000);

type SimulateBody = {
  chainId?: number;
  protocols?: Array<{
    slug?: string;
    tokens?: TokenLimitBody[];
  }>;
  directRules?: DirectRuleBody[];
};

const GAS_DIRECT_RULE_TRANSFER = BigInt(70_000);
const GAS_DIRECT_RULE_APPROVE = BigInt(70_000);
const GAS_DIRECT_RULE_NATIVE = BigInt(60_000);

function normaliseProtocols(body: SimulateBody): {
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

async function getMaxFeePerGas(chainId: number): Promise<bigint> {
  try {
    const { rpcManager } = await buildFailoverRpcManager(chainId);
    const feeData = await rpcManager.executeWithFailover(
      (provider) => provider.getFeeData(),
      "read"
    );
    if (feeData.maxFeePerGas) {
      return feeData.maxFeePerGas;
    }
    if (feeData.gasPrice) {
      return feeData.gasPrice;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_GAS_PRICE_WEI;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Pre-deploy simulate hits RPC + the native-USD price oracle every
    // request. Gate to admin-only so non-admin members can't drive RPC /
    // oracle work from the unauthenticated-feeling preview endpoint
    // (review #923-r3 MEDIUM).
    const admin = await validateSafeAdmin(request);
    if ("error" in admin) {
      return NextResponse.json(
        { error: admin.error },
        { status: admin.status }
      );
    }

    const body = (await request.json()) as SimulateBody;
    const chainId = body.chainId;
    if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
      return NextResponse.json(
        { error: "chainId is required and must be an integer" },
        { status: 400 }
      );
    }
    if (!isSafeSupportedChain(chainId)) {
      return NextResponse.json(
        { error: `Chain ${chainId} is not supported for Safe deployment` },
        { status: 400 }
      );
    }

    const {
      protocols: protocolInputs,
      skipped,
      dropped: droppedProtocols,
    } = normaliseProtocols(body);
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

    const operations: OperationSummary[] = [];
    let totalGas = BigInt(0);

    operations.push({
      label: "Deploy Safe smart account",
      detail:
        "SafeProxyFactory.createProxyWithNonce deploys a fresh Safe whose sole owner is the organization's Turnkey EOA at threshold 1.",
      gasUnits: GAS_DEPLOY_SAFE.toString(),
    });
    totalGas += GAS_DEPLOY_SAFE;

    if (protocolInputs.length > 0) {
      operations.push({
        label: "Deploy Zodiac Roles modifier",
        detail:
          "Deploys a fresh Roles proxy owned by the new Safe via the canonical ModuleProxyFactory.",
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

    const applied: string[] = [];
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
      if (catalog.enforcementLevel === "contract-allowlist") {
        const targets = getProtocolTargets(p.slug as ProtocolSlug, chainId);
        totalTargetScopings += targets.length;
      } else {
        const approxTargets = 2;
        const approxFunctionsPerTarget = 4;
        totalTargetScopings += approxTargets;
        totalFunctionScopings += approxTargets * approxFunctionsPerTarget;
      }
    }

    if (totalTargetScopings > 0 || totalFunctionScopings > 0) {
      const scopeDetail =
        totalFunctionScopings > 0
          ? `~${totalTargetScopings} target allowlistings + ~${totalFunctionScopings} function scopings with parameter conditions (recipient, token allowlist, amount within allowance).`
          : `~${totalTargetScopings} target-level allowlistings (no per-function conditions on these protocols).`;
      operations.push({
        label: `Scope ${applied.length} protocol${applied.length === 1 ? "" : "s"}`,
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

    if (directRulesInput.length > 0) {
      // ERC-20 transfer/approve get scopeFunction with a per-parameter
      // condition (counterparty pinned + amount within allowance), which is
      // pricier than the bare scopeTarget used for native sends. Sum each
      // rule under its kind-specific cost so the wizard preview matches
      // what the install actually pays.
      let directGas = BigInt(0);
      for (const rule of directRulesInput) {
        if (rule.kind === "erc20-transfer") {
          directGas += GAS_DIRECT_RULE_TRANSFER;
        } else if (rule.kind === "erc20-approve") {
          directGas += GAS_DIRECT_RULE_APPROVE;
        } else {
          directGas += GAS_DIRECT_RULE_NATIVE;
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
            return `${r.kind} on ${truncated} (${r.tokenSymbol}, cap ${r.amountHuman} ${formatPeriod(r.periodSeconds)})`;
          })
          .join("; "),
        gasUnits: directGas.toString(),
      });
      totalGas += directGas;
    }

    if (tokenAllowances.length > 0) {
      operations.push({
        label: `Set ${tokenAllowances.length} token allowance${tokenAllowances.length === 1 ? "" : "s"}`,
        detail: tokenAllowances
          .map((a) => {
            const cap = formatTokenAmount(a.maxRefillWei, a.tokenDecimals);
            const truncated = `${a.tokenAddress.slice(0, 6)}...${a.tokenAddress.slice(-4)}`;
            return `${a.tokenSymbol} (${truncated}): cap ${cap} ${a.tokenSymbol} ${formatPeriod(a.periodSeconds)}`;
          })
          .join("; "),
        gasUnits: (
          BigInt(tokenAllowances.length) * GAS_SET_ALLOWANCE
        ).toString(),
      });
      totalGas += BigInt(tokenAllowances.length) * GAS_SET_ALLOWANCE;
    }

    totalGas += GAS_OUTER_WRAPPER;

    const [chainRow] = await db
      .select({ name: chains.name })
      .from(chains)
      .where(eq(chains.chainId, chainId))
      .limit(1);

    const maxFeePerGasWei = await getMaxFeePerGas(chainId);
    const totalCostWei = totalGas * maxFeePerGasWei;
    const totalCostNative = ethers.formatEther(totalCostWei);
    const [totalCostUsd, nativePriceUsd] = await Promise.all([
      weiToUsd({ chainId, amountWei: totalCostWei }),
      getNativeUsdPrice(chainId),
    ]);

    return NextResponse.json({
      safe: {
        chainId,
        chainName: chainRow?.name ?? `chain-${chainId}`,
        safeAddress: "(deterministic CREATE2 address, computed at deploy time)",
      },
      plan: {
        operations,
        totalGasUnits: totalGas.toString(),
        maxFeePerGasWei: maxFeePerGasWei.toString(),
        totalCostWei: totalCostWei.toString(),
        totalCostNative,
        totalCostUsd,
        nativePriceUsd,
        note: "Estimate is heuristic (operation-count times typical cost per operation). Actual gas will vary by ~20%. The Safe's address is computed deterministically from the org and chain at deploy time.",
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
    return apiError(error, "Failed to simulate deploy");
  }
}
