import "server-only";

import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import {
  type ChainId,
  type Condition,
  fetchRole,
  Operator,
  ParameterType,
} from "zodiac-roles-deployments";
import {
  callsPlannedForApplyRole,
  c as conditions,
  encodeCalls,
  type Permission,
  type Role,
  rolesAbi,
} from "zodiac-roles-sdk";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { getTokenInfo } from "@/lib/contracts/tokens";
import { db } from "@/lib/db";
import {
  type SafeRole,
  type SafeRoleAllowance,
  type SafeRoleDirectRule,
  type SafeRoleProtocol,
  type SafeWallet,
  safeRoleAllowances,
  safeRoleDirectRules,
  safeRoleProtocols,
  safeRoles,
  safeWallets,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { startSafeRoleInstallMetrics } from "@/lib/metrics/instrumentation/safe";
import { buildExecTransactionCalldata } from "@/lib/safe/allowance-module";
import {
  TEMPLATE_SPECS,
  type TemplateInput,
  type TemplateSlug,
} from "@/lib/safe/condition-templates";
import { getSafeContracts } from "@/lib/safe/contracts";
import { resolveDefaultTokensForProtocol } from "@/lib/safe/protocol-default-tokens";
import {
  PROTOCOL_CATALOG,
  type ProtocolSlug,
} from "@/lib/safe/protocol-registry";
import { buildFailoverRpcManager } from "@/lib/safe/rpc";
import { buildDesiredRole } from "@/lib/safe/simulate";
import {
  directRuleAllowanceKey,
  getModuleProxyFactoryAddress,
  getRolesSingletonAddress,
  isRolesSupportedChain,
  orgAutomationRoleKey,
  tokenAllowanceKey,
} from "@/lib/safe/zodiac-contracts";
import {
  buildDeployRolesCalldata,
  buildMultiSendCalldata,
  buildRolesSetUpCalldata,
  buildSetAllowanceCalldata,
  findRolesModifierForSafe,
  type MultiSendCall,
  type OnChainAllowance,
  parseModuleProxyCreationEvent,
  readEnabledSafeModules,
  readRoleAllowance,
} from "@/lib/safe/zodiac-roles";
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

const ROLE_TYPE_AUTOMATION = "automation" as const;

/**
 * The per-role ABI encoder, reused across this file. We compute calldata for
 * module methods (enableModule on Safe, assignRoles / setDefaultRole /
 * setAllowance on the modifier) and pack them into MultiSend blobs.
 */
const safeEnableModuleInterface = new ethers.Interface([
  "function enableModule(address module)",
]);
const rolesInterface = new ethers.Interface(rolesAbi);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-token spending cap the admin configured under a protocol. Amount is
 * expressed in human units ("100", "0.5") plus decimals so the orchestrator
 * can convert to wei server-side. Period is daily / weekly / monthly in
 * seconds.
 */
export type TokenLimitInput = {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountHuman: string;
  periodSeconds: number;
};

/**
 * One protocol row from the policy wizard: the admin selected this
 * protocol and scoped it to these tokens with these per-period caps.
 */
export type ProtocolInput = {
  slug: string;
  tokens: TokenLimitInput[];
};

/**
 * "Direct" rules sit outside any protocol preset. They scope the role to
 * call ERC20 transfer / approve / native ETH transfer at a specific
 * counterparty (recipient or spender). Today they install as a target-level
 * allowlist plus a setAllowance bucket for the ERC20 ones. Per-parameter
 * constraints on transfer/approve calldata are a follow-up; the bucket is
 * still useful so the UI can show "remaining this period" from chain.
 */
export type DirectRuleInput = {
  kind: "erc20-transfer" | "erc20-approve" | "native-transfer";
  /** ERC20 token contract address; null for native-transfer */
  tokenAddress: string | null;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Recipient (transfer/native) or spender (approve) */
  counterparty: string;
  amountHuman: string;
  periodSeconds: number;
};

/** Synthetic protocol slug for direct rules in safe_role_allowances. */
export const DIRECT_RULE_PROTOCOL_SLUG = "direct" as const;

/**
 * Sentinel "address" stored in `safe_role_allowances.tokenAddress` and
 * `safe_role_direct_rules.tokenAddress` for native-transfer rules. Both
 * columns are NOT NULL; we use the zero address (matches every wallet/UI's
 * convention for native asset) so the row schema stays uniform and the
 * direct-rules unique index can dedupe native rules without falling into
 * Postgres' NULLs-are-distinct semantics. UI code should treat this value
 * as "native ETH" and skip token-info lookups.
 */
export const NATIVE_TOKEN_SENTINEL =
  "0x0000000000000000000000000000000000000000" as const;

/**
 * Translate the stored token address into the wire/UI format, where
 * native-transfer rules are represented as `null` rather than the
 * sentinel zero-address. Wire format predates the DB sentinel and is
 * what every existing client expects.
 */
export function tokenAddressForWire(stored: string): string | null {
  return stored.toLowerCase() === NATIVE_TOKEN_SENTINEL ? null : stored;
}

/**
 * User-facing message returned by `updateRolesConfig` when a subgraph
 * outage prevents safe diffing. Exported so the unit test asserting the
 * bail path can compare against the exact string we ship.
 */
export const SUBGRAPH_OUTAGE_UPDATE_ERROR =
  "The Zodiac subgraph is currently unreachable, so direct-rule details cannot be verified against on-chain state. Retry once the subgraph is available; the update has been refused to avoid silently removing on-chain direct-rule scopes.";

/**
 * Pure predicate driving the subgraph-outage bail in `updateRolesConfig`.
 * Lifted out of the function body so the regression test for review
 * #923-r2 (HIGH) can exercise it without mocking the entire orchestrator.
 *
 * Returns true when the update would touch direct rules in any way
 * (existing in DB or desired in the input) while the subgraph couldn't
 * confirm chain state. Both-zero is the only safe-to-proceed case.
 */
export function shouldBailOnSubgraphOutage(input: {
  existingDirectRulesCount: number;
  desiredDirectRulesCount: number;
}): boolean {
  return (
    input.existingDirectRulesCount > 0 || input.desiredDirectRulesCount > 0
  );
}

/**
 * 4-byte function selectors for the ERC-20 methods we scope under direct
 * rules. Stored verbatim on `safe_role_protocols.allowedSelectors` so the
 * audit panel can show "transfer(address,uint256)" alongside the rule.
 */
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb" as const;
const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as const;

/** Function signatures matching the selectors above. The signature form is
 * what the SDK's permission planner needs to decompose calldata into the
 * (recipient, amount) tuple our condition matches against. */
const ERC20_TRANSFER_SIGNATURE = "transfer(address,uint256)" as const;
const ERC20_APPROVE_SIGNATURE = "approve(address,uint256)" as const;

export function directRuleSelector(
  kind: DirectRuleInput["kind"]
): `0x${string}` | null {
  if (kind === "erc20-transfer") {
    return ERC20_TRANSFER_SELECTOR;
  }
  if (kind === "erc20-approve") {
    return ERC20_APPROVE_SELECTOR;
  }
  return null;
}

function directRuleSignature(kind: DirectRuleInput["kind"]): string | null {
  if (kind === "erc20-transfer") {
    return ERC20_TRANSFER_SIGNATURE;
  }
  if (kind === "erc20-approve") {
    return ERC20_APPROVE_SIGNATURE;
  }
  return null;
}

/**
 * Build the on-chain `Permission` for a direct rule.
 *
 * - For ERC-20 transfer/approve we emit a `FunctionPermission` scoped to the
 *   token contract, the function signature, and a `matches` condition that
 *   pins the first parameter (recipient/spender) to the configured
 *   counterparty and binds the second parameter (amount) to the per-token
 *   allowance bucket. This means a role holder cannot redirect transfers /
 *   approvals to a different address even though they hold the role key.
 *
 * - For native ETH transfers we still emit a target-only `TargetPermission`
 *   with `send: true`. The Roles modifier doesn't expose a value cap on raw
 *   sends; tightening this needs a transaction guard which is out of scope
 *   here. The wizard banner makes the limitation explicit.
 *
 * Returns `null` for malformed rules so the caller can drop them without
 * tripping the SDK's planner.
 */
export function buildDirectRulePermission(
  rule: DirectRuleInput,
  allowanceKey: `0x${string}` | null
): Permission | null {
  if (!ethers.isAddress(rule.counterparty)) {
    return null;
  }
  const counterparty = ethers.getAddress(rule.counterparty) as `0x${string}`;

  if (rule.kind === "native-transfer") {
    // Per-period value cap for native sends uses the modifier's
    // EtherWithinAllowance operator. Without an allowanceKey we fall back to
    // a target-only permission (no cap on value sent to the counterparty).
    if (allowanceKey) {
      return {
        targetAddress: counterparty,
        send: true,
        delegatecall: false,
        etherWithinAllowance: allowanceKey,
      } as unknown as Permission;
    }
    return {
      targetAddress: counterparty,
      send: true,
      delegatecall: false,
    } as unknown as Permission;
  }

  if (!(rule.tokenAddress && ethers.isAddress(rule.tokenAddress))) {
    return null;
  }
  const signature = directRuleSignature(rule.kind);
  if (!(signature && allowanceKey)) {
    return null;
  }
  const tokenAddress = ethers.getAddress(rule.tokenAddress) as `0x${string}`;

  return {
    targetAddress: tokenAddress,
    signature,
    condition: conditions.calldataMatches(
      [conditions.eq(counterparty), conditions.withinAllowance(allowanceKey)],
      ["address", "uint256"]
    ),
    send: false,
    delegatecall: false,
  } as unknown as Permission;
}

export type InstallRoleInput = {
  organizationId: string;
  chainId: number;
  protocols: ProtocolInput[];
  directRules?: DirectRuleInput[];
};

export type InstallRoleResult =
  | {
      success: true;
      role: SafeRole;
      protocols: SafeRoleProtocol[];
      allowances: SafeRoleAllowance[];
      applied: string[];
      skipped: string[];
      /**
       * Direct rules that the orchestrator could not turn into a Permission
       * (malformed counterparty, missing token address, etc). The wizard
       * surfaces these to the admin so a silently dropped rule is visible.
       */
      skippedDirectRules: string[];
      alreadyInstalled: boolean;
    }
  | { success: false; error: string };

export type SetAllowanceInput = {
  organizationId: string;
  chainId: number;
  protocolSlug: string;
  tokenAddress: string;
  maxRefillWei: string;
  refillWei: string;
  periodSeconds: number;
  /** Optional overrides used when the token isn't in the server registry */
  tokenSymbol?: string;
  tokenDecimals?: number;
};

export type SetAllowanceResult =
  | { success: true; allowance: SafeRoleAllowance }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function findSafeForOrg(
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

async function findRoleForSafe(safeWalletId: string): Promise<SafeRole | null> {
  const rows = await db
    .select()
    .from(safeRoles)
    .where(
      and(
        eq(safeRoles.safeWalletId, safeWalletId),
        eq(safeRoles.roleType, ROLE_TYPE_AUTOMATION)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

function resolveTokenMetadata(
  chainId: number,
  tokenAddress: string,
  fallbackSymbol?: string,
  fallbackDecimals?: number
): { symbol: string; decimals: number } {
  const info = getTokenInfo(chainId, tokenAddress);
  if (info) {
    return { symbol: info.symbol, decimals: info.decimals };
  }
  return {
    symbol: fallbackSymbol ?? "UNKNOWN",
    decimals: fallbackDecimals ?? 18,
  };
}

/**
 * Compile the Permission[] for the admin's selected protocols, merging every
 * protocol's preset into one flat list. The SDK's processPermissions handles
 * merging duplicates across protocols when the same target+selector appears.
 */
async function buildPermissionsForProtocols(options: {
  chainId: number;
  safeAddress: `0x${string}`;
  protocols: string[];
  allowedTokenSymbols: string[];
}): Promise<{
  permissions: Permission[];
  applied: string[];
  skipped: string[];
}> {
  const input: TemplateInput = {
    chainId: options.chainId,
    allowedTokenSymbols: options.allowedTokenSymbols,
    safeAddress: options.safeAddress,
  };
  const permissions: Permission[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const slug of options.protocols) {
    const catalog = PROTOCOL_CATALOG[slug as keyof typeof PROTOCOL_CATALOG];
    if (!catalog?.chainIds.includes(options.chainId)) {
      // Protocol not recognised on this chain yet. Skip gracefully so the
      // rest of the install can proceed; the API returns the skipped list.
      skipped.push(slug);
      continue;
    }
    const template = TEMPLATE_SPECS[catalog.templateSlug as TemplateSlug];
    if (!template) {
      skipped.push(slug);
      continue;
    }
    try {
      const permissionSet = await template.build(input);
      for (const p of permissionSet) {
        permissions.push(p);
      }
      applied.push(slug);
    } catch {
      // A preset can throw if defi-kit rejects the token symbols (e.g.
      // asking Aave for a token it has no reserve for). Swallow per
      // protocol so one bad selection doesn't block the rest.
      skipped.push(slug);
    }
  }
  return { permissions, applied, skipped };
}

/**
 * Compute the deterministic address the ModuleProxyFactory will deploy the
 * Roles modifier to. Same as the Safe ProxyFactory trick: minimal proxy
 * bytecode + singleton = deterministic CREATE2 address.
 *
 * We could also call `proxyCreationCode()` on the factory at runtime, but
 * for typed callers we prefer parsing the event on the deploy tx receipt
 * and using that as the authoritative address. This helper exists for
 * pre-flight display only.
 */
function defaultSaltNonce(options: {
  organizationId: string;
  chainId: number;
}): bigint {
  const encoded = ethers.solidityPacked(
    ["string", "string", "uint256"],
    ["kh-zodiac-roles", options.organizationId, BigInt(options.chainId)]
  );
  const hash = ethers.keccak256(encoded);
  return BigInt(`0x${hash.slice(-32)}`);
}

// ---------------------------------------------------------------------------
// Install: deploy Roles modifier + enableModule + assignRoles + initial scope
// ---------------------------------------------------------------------------

/**
 * First-time installation flow. Runs two on-chain transactions:
 *
 * 1. `moduleProxyFactory.deployModule(rolesSingleton, setUp(init), salt)` —
 *    owner-signed from the Turnkey EOA. Captures the proxy address from the
 *    `ModuleProxyCreation` event.
 *
 * 2. A single Safe.execTransaction wrapping a MultiSend that:
 *    - Safe.enableModule(proxy)
 *    - proxy.assignRoles(delegate, [roleKey], [true])
 *    - proxy.setDefaultRole(delegate, roleKey)
 *    - Role target/function scoping (from processed permissions)
 *    - proxy.setAllowance(...) per requested token allowance
 *
 * Idempotent: if a `safe_roles` row already exists and the modifier is
 * enabled on chain, the call returns the existing row without a second tx.
 */
const HUMAN_AMOUNT_REGEX = /^\d+(\.\d+)?$/;
const LEADING_ZEROS_REGEX = /^0+/;
const TRAILING_ZEROS_REGEX = /0+$/;
const TRAILING_DOT_REGEX = /\.$/;

/**
 * Convert "100.5" + decimals=6 into BigInt(100500000). Rejects malformed
 * numbers with a clear error so the orchestrator can short-circuit before
 * sending any tx.
 */
function humanToWei(amountHuman: string, decimals: number): bigint {
  const trimmed = amountHuman.trim();
  if (!HUMAN_AMOUNT_REGEX.test(trimmed)) {
    throw new Error(`Invalid amount: ${amountHuman}`);
  }
  const [intPart, fracRaw] = trimmed.split(".");
  const fracPart = (fracRaw ?? "").padEnd(decimals, "0").slice(0, decimals);
  const combined =
    `${intPart}${fracPart}`.replace(LEADING_ZEROS_REGEX, "") || "0";
  return BigInt(combined);
}

/**
 * Per-(protocol, token) allowance entry emitted by `flattenInstallInput`.
 * Each row maps directly to one on-chain `setAllowance` call and one
 * `safe_role_allowances` DB row.
 */
export type FlattenedAllowance = {
  protocolSlug: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  maxRefillWei: string;
  refillWei: string;
  periodSeconds: number;
  /**
   * When set, this row originated from a direct rule. The orchestrator
   * derives the on-chain allowance key from `(kind, counterparty)` so two
   * direct rules on the same token (e.g. approve + transfer) get
   * independent buckets that match what the wizard's per-rule cap implies.
   */
  directRule?: {
    kind: DirectRuleInput["kind"];
    counterparty: string;
  };
};

/**
 * Resolve the on-chain allowance key for a flattened row. Direct rules use
 * a per-rule key (kind + counterparty) so two direct rules on the same
 * token get independent buckets; protocol presets use the per-protocol key.
 */
function resolveAllowanceKey(
  roleKey: string,
  row: Pick<FlattenedAllowance, "protocolSlug" | "tokenAddress" | "directRule">
): `0x${string}` {
  if (row.directRule) {
    return directRuleAllowanceKey(
      roleKey,
      row.directRule.kind,
      row.directRule.counterparty,
      row.tokenAddress
    ) as `0x${string}`;
  }
  return tokenAllowanceKey(
    roleKey,
    row.protocolSlug,
    row.tokenAddress
  ) as `0x${string}`;
}

/**
 * Compute the on-chain allowance key for a direct rule's Permission. For
 * native-transfer rules we use NATIVE_TOKEN_SENTINEL — matching the
 * bucket the allowance loop creates and the modifier's
 * EtherWithinAllowance operator reads from. For ERC-20 rules we lower
 * the token address through normalizeAddressForStorage. Returns null
 * only when the rule is malformed (ERC-20 without a token address);
 * the caller skips emitting a Permission in that case.
 *
 * Previously native rules short-circuited to null at every call site,
 * leaving the modifier with a target-only permission and the value cap
 * unenforced. The bucket was still being created on chain by the
 * allowance loop, but no condition pointed at it — silent dead branch
 * caught by Jacob's review of #923.
 */
function buildDirectRuleAllowanceKey(
  roleKey: string,
  rule: Pick<DirectRuleInput, "kind" | "counterparty" | "tokenAddress">
): `0x${string}` | null {
  if (rule.kind === "native-transfer") {
    return directRuleAllowanceKey(
      roleKey,
      rule.kind,
      rule.counterparty,
      NATIVE_TOKEN_SENTINEL
    ) as `0x${string}`;
  }
  if (!rule.tokenAddress) {
    return null;
  }
  return directRuleAllowanceKey(
    roleKey,
    rule.kind,
    rule.counterparty,
    normalizeAddressForStorage(rule.tokenAddress)
  ) as `0x${string}`;
}

/**
 * Flatten per-protocol token configuration. No cross-protocol aggregation:
 * each `(protocolSlug, tokenAddress)` pair becomes its own allowance bucket
 * so two protocols can hold independent caps for the same token.
 *
 * Returns the slug list (for `buildPermissionsForProtocols`), the union of
 * token symbols (what the per-parameter presets scope), and the flat list
 * of allowance rows.
 */
export function flattenInstallInput(
  protocolInputs: ProtocolInput[],
  directRules: DirectRuleInput[] = []
): {
  protocolSlugs: string[];
  allowedTokenSymbols: string[];
  allowances: FlattenedAllowance[];
} {
  const slugs = protocolInputs.map((p) => p.slug);
  const symbols = new Set<string>();
  const allowances: FlattenedAllowance[] = [];

  for (const p of protocolInputs) {
    for (const t of p.tokens) {
      symbols.add(t.tokenSymbol);
      const addr = normalizeAddressForStorage(t.tokenAddress);
      const amount = humanToWei(t.amountHuman, t.tokenDecimals);
      allowances.push({
        protocolSlug: p.slug,
        tokenAddress: addr,
        tokenSymbol: t.tokenSymbol,
        tokenDecimals: t.tokenDecimals,
        maxRefillWei: amount.toString(),
        refillWei: amount.toString(),
        periodSeconds: t.periodSeconds,
      });
    }
  }

  // Direct rules emit one allowance bucket per rule. ERC-20 rules use
  // c.calldataMatches([eq(counterparty), withinAllowance(key)]); native
  // rules use the modifier's EtherWithinAllowance operator on the target
  // permission. Each rule's bucket key folds in (kind, counterparty) so
  // separate rules never share a cap.
  for (const rule of directRules) {
    if (rule.kind !== "native-transfer" && !rule.tokenAddress) {
      continue;
    }
    const isNative = rule.kind === "native-transfer";
    const addr = isNative
      ? NATIVE_TOKEN_SENTINEL
      : normalizeAddressForStorage(rule.tokenAddress as string);
    const amount = humanToWei(rule.amountHuman, rule.tokenDecimals);
    symbols.add(rule.tokenSymbol);
    allowances.push({
      protocolSlug: DIRECT_RULE_PROTOCOL_SLUG,
      tokenAddress: addr,
      tokenSymbol: rule.tokenSymbol,
      tokenDecimals: rule.tokenDecimals,
      maxRefillWei: amount.toString(),
      refillWei: amount.toString(),
      periodSeconds: rule.periodSeconds,
      directRule: {
        kind: rule.kind,
        counterparty: rule.counterparty,
      },
    });
  }

  return {
    protocolSlugs: slugs,
    allowedTokenSymbols: Array.from(symbols),
    allowances,
  };
}

export async function installRolesWithInitialConfig(
  input: InstallRoleInput
): Promise<InstallRoleResult> {
  const {
    organizationId,
    chainId,
    protocols: protocolInputs,
    directRules = [],
  } = input;

  if (!isRolesSupportedChain(chainId)) {
    return {
      success: false,
      error: `Zodiac Roles is not deployed on chain ${chainId} yet. Safe transactions on this chain still work via the owner-signed path; switch to a supported chain to install policies.`,
    };
  }

  const {
    protocolSlugs: protocols,
    allowedTokenSymbols,
    allowances: tokenAllowances,
  } = flattenInstallInput(protocolInputs, directRules);

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return {
      success: false,
      error: "Deploy a Safe on this chain before installing Zodiac Roles",
    };
  }
  if (safe.status !== "deployed") {
    return {
      success: false,
      error: `Safe is not yet deployed (status: ${safe.status})`,
    };
  }

  const existingRole = await findRoleForSafe(safe.id);
  if (existingRole && existingRole.status === "active") {
    const protocolRows = await db
      .select()
      .from(safeRoleProtocols)
      .where(eq(safeRoleProtocols.roleId, existingRole.id));
    const allowanceRows = await db
      .select()
      .from(safeRoleAllowances)
      .where(eq(safeRoleAllowances.roleId, existingRole.id));
    return {
      success: true,
      role: existingRole,
      protocols: protocolRows,
      allowances: allowanceRows,
      applied: protocolRows.map((r) => r.protocolSlug),
      skipped: [],
      skippedDirectRules: [],
      alreadyInstalled: true,
    };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const safeAddress = safe.safeAddress as `0x${string}`;
  const rolesSingleton = getRolesSingletonAddress(chainId);
  const moduleProxyFactory = getModuleProxyFactoryAddress(chainId);
  const multiSendAddress = getSafeContracts(chainId).multiSendCallOnly;
  const roleKey = orgAutomationRoleKey(
    organizationId,
    chainId
  ) as `0x${string}`;
  const saltNonce = defaultSaltNonce({ organizationId, chainId });

  const { rpcManager, rpcUrl } = await buildFailoverRpcManager(chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  const context: TransactionContext = {
    organizationId,
    executionId: `safe-roles-install-${generateId()}`,
    chainId,
    rpcUrl,
    rpcManager,
  };

  const finishMetrics = startSafeRoleInstallMetrics(chainId);
  try {
    // Step 1 — deploy the Roles modifier proxy
    const setUpCalldata = buildRolesSetUpCalldata({
      owner: safeAddress,
      avatar: safeAddress,
      target: safeAddress,
    });
    const deployCalldata = buildDeployRolesCalldata({
      rolesSingleton,
      initializer: setUpCalldata,
      saltNonce,
    });

    const deployResult = await withNonceSession(
      context,
      ownerAddress,
      (session) =>
        executeTransaction(
          context,
          ownerAddress,
          () => ({
            to: moduleProxyFactory,
            data: deployCalldata,
            value: BigInt(0),
            chainId,
          }),
          session
        )
    );

    if (!(deployResult.success && deployResult.receipt)) {
      throw new Error(deployResult.error ?? "Roles modifier deploy reverted");
    }

    const rolesModifierAddress = parseModuleProxyCreationEvent(
      deployResult.receipt,
      moduleProxyFactory
    ) as `0x${string}`;

    // Step 2 build the config MultiSend. Some protocols may not have a
    // condition template yet; we skip those here and let the UI know which
    // were applied vs skipped so the admin can retry later.
    const {
      permissions,
      applied: appliedProtocols,
      skipped: skippedProtocols,
    } = await buildPermissionsForProtocols({
      chainId,
      safeAddress,
      protocols,
      allowedTokenSymbols,
    });

    // Direct rules: ERC-20 transfer/approve get a FunctionPermission with a
    // `matches` condition that pins the recipient/spender argument to the
    // configured counterparty and binds the amount argument to the per-token
    // allowance bucket. Native transfers stay as a target-only allowlist.
    // The on-chain allowance bucket for ERC-20 direct rules is created in
    // the per-allowance loop further below using the same allowanceKey.
    const directRulePermissions: Permission[] = [];
    const skippedDirectRules: string[] = [];
    for (const rule of directRules) {
      const allowanceKey = buildDirectRuleAllowanceKey(roleKey, rule);
      const permission = buildDirectRulePermission(rule, allowanceKey);
      if (permission) {
        directRulePermissions.push(permission);
      } else {
        skippedDirectRules.push(
          `${rule.kind} ${rule.tokenSymbol} -> ${rule.counterparty}`
        );
      }
    }

    const desiredRole: Role = buildDesiredRole({
      roleKey,
      delegate: ownerAddress as `0x${string}`,
      permissions: [...permissions, ...directRulePermissions],
    });
    const emptyRole: Role = {
      key: roleKey,
      members: [],
      targets: [],
      annotations: [],
      lastUpdate: 0,
    };
    const permissionCalls = callsPlannedForApplyRole(emptyRole, desiredRole);
    const encodedPermissionCalls = encodeCalls(
      permissionCalls,
      rolesModifierAddress
    );

    const multiSendCalls: MultiSendCall[] = [];

    // a. enableModule on Safe
    multiSendCalls.push({
      to: safeAddress,
      data: safeEnableModuleInterface.encodeFunctionData("enableModule", [
        rolesModifierAddress,
      ]),
      value: BigInt(0),
      operation: 0,
    });

    // b. assignRoles + setDefaultRole on modifier
    multiSendCalls.push({
      to: rolesModifierAddress,
      data: rolesInterface.encodeFunctionData("assignRoles", [
        ownerAddress,
        [roleKey],
        [true],
      ]),
      value: BigInt(0),
      operation: 0,
    });
    multiSendCalls.push({
      to: rolesModifierAddress,
      data: rolesInterface.encodeFunctionData("setDefaultRole", [
        ownerAddress,
        roleKey,
      ]),
      value: BigInt(0),
      operation: 0,
    });

    // c. role scope + allowFunction + scopeFunction calls from the planner
    for (const call of encodedPermissionCalls) {
      multiSendCalls.push({
        to: call.to,
        data: call.data,
        value: BigInt(0),
        operation: 0,
      });
    }

    // d. per-(protocol, token) allowances
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const allowanceRowsInput: Array<{
      protocolSlug: string;
      allowanceKey: `0x${string}`;
      tokenAddress: string;
      tokenSymbol: string;
      tokenDecimals: number;
      maxRefillWei: string;
      refillWei: string;
      periodSeconds: number;
    }> = [];
    for (const a of tokenAllowances) {
      const normalizedToken = normalizeAddressForStorage(a.tokenAddress);
      const allowanceKey = resolveAllowanceKey(roleKey, {
        protocolSlug: a.protocolSlug,
        tokenAddress: normalizedToken,
        directRule: a.directRule,
      });
      const { symbol, decimals } = resolveTokenMetadata(
        chainId,
        normalizedToken,
        a.tokenSymbol,
        a.tokenDecimals
      );
      const maxRefill = BigInt(a.maxRefillWei);
      const refill = BigInt(a.refillWei);
      multiSendCalls.push({
        to: rolesModifierAddress,
        data: buildSetAllowanceCalldata({
          allowanceKey,
          balance: maxRefill,
          maxRefill,
          refill,
          period: BigInt(a.periodSeconds),
          timestamp: nowSec,
        }),
        value: BigInt(0),
        operation: 0,
      });
      allowanceRowsInput.push({
        protocolSlug: a.protocolSlug,
        allowanceKey,
        tokenAddress: normalizedToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        maxRefillWei: a.maxRefillWei,
        refillWei: a.refillWei,
        periodSeconds: a.periodSeconds,
      });
    }

    const multiSendCalldata = buildMultiSendCalldata(multiSendCalls);
    const outerCalldata = buildExecTransactionCalldata({
      to: multiSendAddress,
      data: multiSendCalldata,
      value: BigInt(0),
      operation: 1,
      ownerAddress,
    });

    const configResult = await withNonceSession(
      context,
      ownerAddress,
      (session) =>
        executeTransaction(
          context,
          ownerAddress,
          () => ({
            to: safeAddress,
            data: outerCalldata,
            value: BigInt(0),
            chainId,
          }),
          session
        )
    );

    if (!(configResult.success && configResult.receipt)) {
      throw new Error(configResult.error ?? "Role configuration tx reverted");
    }

    // Persist the caches atomically. Pre-fix this was three sequential
    // db.insert calls; if any one threw (FK timing, duplicate-key on retry,
    // connection blip) the on-chain state was already ahead of the DB and
    // there was no recovery path. Wrap in db.transaction + upserts so a
    // partial failure rolls back and a retry of installRolesWithInitialConfig
    // converges on the same DB state instead of throwing on the unique key.
    const installedTxHash = deployResult.txHash ?? configResult.txHash ?? null;
    const lastAppliedTxHash = configResult.txHash ?? null;
    const persistResult = await db.transaction(async (tx) => {
      const [roleRow] = await tx
        .insert(safeRoles)
        .values({
          safeWalletId: safe.id,
          roleType: ROLE_TYPE_AUTOMATION,
          roleKey,
          rolesModifierAddress:
            normalizeAddressForStorage(rolesModifierAddress),
          delegateAddress: ownerAddress,
          installedTxHash,
          lastReconciledAt: new Date(),
          status: "active",
        })
        .onConflictDoUpdate({
          target: [safeRoles.safeWalletId, safeRoles.roleType],
          set: {
            roleKey,
            rolesModifierAddress:
              normalizeAddressForStorage(rolesModifierAddress),
            delegateAddress: ownerAddress,
            installedTxHash,
            lastReconciledAt: new Date(),
            status: "active",
            updatedAt: new Date(),
          },
        })
        .returning();

      // Only persist protocols the orchestrator actually applied on-chain.
      // Skipped ones (template pending or defi-kit rejected the token set)
      // are surfaced back to the UI via the `skippedProtocols` field on the
      // response so the admin can retry when templates ship.
      const protocolRows: SafeRoleProtocol[] = [];
      for (const slug of appliedProtocols) {
        const catalog = PROTOCOL_CATALOG[slug as keyof typeof PROTOCOL_CATALOG];
        if (!catalog) {
          continue;
        }
        const [row] = await tx
          .insert(safeRoleProtocols)
          .values({
            roleId: roleRow.id,
            protocolSlug: slug,
            templateSlug: catalog.templateSlug,
            allowedTokenSymbols,
            targetAddresses: [],
            allowedSelectors: [],
            status: "allowed",
            lastAppliedTxHash,
          })
          .onConflictDoUpdate({
            target: [safeRoleProtocols.roleId, safeRoleProtocols.protocolSlug],
            set: {
              templateSlug: catalog.templateSlug,
              allowedTokenSymbols,
              status: "allowed",
              lastAppliedTxHash,
              lastUpdatedAt: new Date(),
            },
          })
          .returning();
        protocolRows.push(row);
      }

      // Direct rules: persist a synthetic protocol row with the actual
      // selectors so the audit panel can show what's allowed.
      for (const rule of directRules) {
        if (rule.kind === "native-transfer") {
          continue;
        }
        const selector = directRuleSelector(rule.kind);
        if (!selector) {
          continue;
        }
        const [row] = await tx
          .insert(safeRoleProtocols)
          .values({
            roleId: roleRow.id,
            protocolSlug: DIRECT_RULE_PROTOCOL_SLUG,
            templateSlug: "direct",
            allowedTokenSymbols,
            targetAddresses: [],
            allowedSelectors: [selector],
            status: "allowed",
            lastAppliedTxHash,
          })
          .onConflictDoUpdate({
            target: [safeRoleProtocols.roleId, safeRoleProtocols.protocolSlug],
            set: {
              templateSlug: "direct",
              allowedTokenSymbols,
              allowedSelectors: [selector],
              status: "allowed",
              lastAppliedTxHash,
              lastUpdatedAt: new Date(),
            },
          })
          .returning();
        if (row && !protocolRows.some((p) => p.id === row.id)) {
          protocolRows.push(row);
        }
      }

      for (const rule of directRules) {
        if (!rule.counterparty) {
          continue;
        }
        const normalizedCounterparty = ethers.isAddress(rule.counterparty)
          ? ethers.getAddress(rule.counterparty)
          : rule.counterparty;
        const normalizedTokenAddress = rule.tokenAddress
          ? normalizeAddressForStorage(rule.tokenAddress)
          : NATIVE_TOKEN_SENTINEL;
        await tx
          .insert(safeRoleDirectRules)
          .values({
            roleId: roleRow.id,
            kind: rule.kind,
            tokenAddress: normalizedTokenAddress,
            tokenSymbol: rule.tokenSymbol,
            tokenDecimals: rule.tokenDecimals,
            counterparty: normalizedCounterparty,
            amountHuman: rule.amountHuman,
            periodSeconds: rule.periodSeconds,
            status: "allowed",
            lastAppliedTxHash,
          })
          .onConflictDoUpdate({
            target: [
              safeRoleDirectRules.roleId,
              safeRoleDirectRules.kind,
              safeRoleDirectRules.tokenAddress,
              safeRoleDirectRules.counterparty,
            ],
            set: {
              tokenSymbol: rule.tokenSymbol,
              tokenDecimals: rule.tokenDecimals,
              amountHuman: rule.amountHuman,
              periodSeconds: rule.periodSeconds,
              status: "allowed",
              lastAppliedTxHash,
              lastUpdatedAt: new Date(),
            },
          });
      }

      const allowanceRows: SafeRoleAllowance[] = [];
      for (const a of allowanceRowsInput) {
        const [row] = await tx
          .insert(safeRoleAllowances)
          .values({
            roleId: roleRow.id,
            protocolSlug: a.protocolSlug,
            allowanceKey: a.allowanceKey,
            tokenAddress: a.tokenAddress,
            tokenSymbol: a.tokenSymbol,
            tokenDecimals: a.tokenDecimals,
            maxRefillWei: a.maxRefillWei,
            refillWei: a.refillWei,
            periodSeconds: a.periodSeconds,
            lastChainBalanceWei: a.maxRefillWei,
            lastChainTimestamp: new Date(Number(nowSec) * 1000),
            lastReconciledAt: new Date(),
            lastAppliedTxHash,
          })
          .onConflictDoUpdate({
            target: [
              safeRoleAllowances.roleId,
              safeRoleAllowances.allowanceKey,
            ],
            set: {
              protocolSlug: a.protocolSlug,
              tokenAddress: a.tokenAddress,
              tokenSymbol: a.tokenSymbol,
              tokenDecimals: a.tokenDecimals,
              maxRefillWei: a.maxRefillWei,
              refillWei: a.refillWei,
              periodSeconds: a.periodSeconds,
              lastChainBalanceWei: a.maxRefillWei,
              lastChainTimestamp: new Date(Number(nowSec) * 1000),
              lastReconciledAt: new Date(),
              lastAppliedTxHash,
              lastUpdatedAt: new Date(),
            },
          })
          .returning();
        allowanceRows.push(row);
      }

      return { roleRow, protocolRows, allowanceRows };
    });

    finishMetrics("success");
    return {
      success: true,
      role: persistResult.roleRow,
      protocols: persistResult.protocolRows,
      allowances: persistResult.allowanceRows,
      applied: appliedProtocols,
      skipped: skippedProtocols,
      skippedDirectRules,
      alreadyInstalled: false,
    };
  } catch (error) {
    finishMetrics("failure");
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Zodiac Roles install failed for org=${organizationId} chain=${chainId}`,
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: chainId.toString(),
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Update: diff current vs desired Role state and apply only what changed
// ---------------------------------------------------------------------------

export type UpdateRoleInput = {
  organizationId: string;
  chainId: number;
  /** Full desired protocol config; not a delta. */
  protocols: ProtocolInput[];
  /** Full desired direct rules; not a delta. */
  directRules?: DirectRuleInput[];
};

export type UpdateRoleResult =
  | {
      success: true;
      role: SafeRole;
      protocols: SafeRoleProtocol[];
      allowances: SafeRoleAllowance[];
      applied: string[];
      skipped: string[];
      /** See InstallRoleResult.skippedDirectRules. */
      skippedDirectRules: string[];
      noChanges: boolean;
      addedProtocols: number;
      removedProtocols: number;
      addedAllowances: number;
      changedAllowances: number;
      revokedAllowances: number;
    }
  | { success: false; error: string };

/**
 * Diff two flattened allowance sets keyed by `allowanceKey`. The on-chain
 * Modifier doesn't expose a deleteAllowance call, so revocation is modeled
 * as `setAllowance(key, 0, 0, 0, 0, now)` -- effectively a permanently
 * empty bucket that no condition can satisfy.
 */
function diffAllowances(
  current: SafeRoleAllowance[],
  desired: Array<FlattenedAllowance & { allowanceKey: `0x${string}` }>,
  nowSec: bigint
): {
  setCalls: MultiSendCall[];
  added: number;
  changed: number;
  revoked: number;
} {
  const desiredByKey = new Map<
    string,
    FlattenedAllowance & { allowanceKey: `0x${string}` }
  >();
  for (const d of desired) {
    desiredByKey.set(d.allowanceKey.toLowerCase(), d);
  }
  const currentByKey = new Map<string, SafeRoleAllowance>();
  for (const c of current) {
    currentByKey.set(c.allowanceKey.toLowerCase(), c);
  }

  let added = 0;
  let changed = 0;
  let revoked = 0;
  const setCalls: MultiSendCall[] = [];

  for (const [keyLower, d] of desiredByKey.entries()) {
    const existing = currentByKey.get(keyLower);
    const maxRefill = BigInt(d.maxRefillWei);
    const refill = BigInt(d.refillWei);
    if (
      existing &&
      existing.maxRefillWei === d.maxRefillWei &&
      existing.refillWei === d.refillWei &&
      existing.periodSeconds === d.periodSeconds
    ) {
      // Unchanged bucket -- skip.
      continue;
    }
    setCalls.push({
      to: "ROLES_MODIFIER_PLACEHOLDER",
      data: buildSetAllowanceCalldata({
        allowanceKey: d.allowanceKey,
        balance: maxRefill,
        maxRefill,
        refill,
        period: BigInt(d.periodSeconds),
        timestamp: nowSec,
      }),
      value: BigInt(0),
      operation: 0,
    });
    if (existing) {
      changed += 1;
    } else {
      added += 1;
    }
  }

  for (const [keyLower, existing] of currentByKey.entries()) {
    if (desiredByKey.has(keyLower)) {
      continue;
    }
    setCalls.push({
      to: "ROLES_MODIFIER_PLACEHOLDER",
      data: buildSetAllowanceCalldata({
        allowanceKey: existing.allowanceKey as `0x${string}`,
        balance: BigInt(0),
        maxRefill: BigInt(0),
        refill: BigInt(0),
        period: BigInt(0),
        timestamp: nowSec,
      }),
      value: BigInt(0),
      operation: 0,
    });
    revoked += 1;
  }

  return { setCalls, added, changed, revoked };
}

/**
 * Update an already-installed Role to a new desired state.
 *
 * Computes the minimal diff between what's currently configured (DB cache,
 * refreshed from chain via `reconcileSafeRoleFromChain` first) and the
 * desired protocols + direct rules. Submits exactly one Safe transaction
 * wrapping a MultiSend of the diff calls (`scopeTarget`, `scopeFunction`,
 * `revokeFunction`, `setAllowance`). On success, persists the DB delta in
 * a single `db.transaction` so partial failures don't leave a half-updated
 * cache.
 *
 * Constraints in this revision:
 * - Direct rule REMOVAL is not supported via this path (we don't persist
 *   counterparties, so the diff can't tell that a rule was dropped). Use
 *   the per-allowance Revoke button on the role card to remove an ERC-20
 *   direct rule's bucket. New direct rules in the input are added; existing
 *   ones may produce idempotent re-scope calls (cost: a small amount of
 *   gas, no correctness issue because scopeFunction is idempotent for the
 *   same conditions).
 */
export async function updateRolesConfig(
  input: UpdateRoleInput
): Promise<UpdateRoleResult> {
  const {
    organizationId,
    chainId,
    protocols: protocolInputs,
    directRules = [],
  } = input;

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return { success: false, error: "No Safe deployed on this chain" };
  }
  if (safe.status !== "deployed") {
    return {
      success: false,
      error: `Safe is not yet deployed (status: ${safe.status})`,
    };
  }

  // Refresh DB from chain before diffing so we're not editing against a
  // stale cache. The reconcile is idempotent and creates the role row if
  // it's missing (silent-write recovery path).
  const reconciled = await reconcileSafeRoleFromChain(safe);
  if (!reconciled.success) {
    return {
      success: false,
      error: `Reconcile before update failed: ${reconciled.error}`,
    };
  }
  if (!reconciled.installed) {
    return {
      success: false,
      error:
        "No Roles modifier is enabled on this Safe. Run install before updating.",
    };
  }

  const role = reconciled.role;
  const currentProtocolRows = reconciled.protocols;
  const currentAllowanceRows = reconciled.allowances;

  // Subgraph-outage guard: if the Zodiac subgraph was unreachable during the
  // pre-update reconcile, direct-rule details (kind, counterparty) could not
  // be re-fetched. Proceeding would build the SDK diff against a possibly
  // stale set of current direct rules and strip their scope from the modifier
  // on chain. Bail with an actionable retry message instead. The narrower
  // case where no direct rules exist on either side is safe — nothing to lose.
  // See review #923-r2 (HIGH).
  if (reconciled.subgraphUnreachable) {
    const existingDirectRules = await listRoleDirectRules(role.id);
    if (
      shouldBailOnSubgraphOutage({
        existingDirectRulesCount: existingDirectRules.length,
        desiredDirectRulesCount: directRules.length,
      })
    ) {
      return {
        success: false,
        error: SUBGRAPH_OUTAGE_UPDATE_ERROR,
      };
    }
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const safeAddress = safe.safeAddress as `0x${string}`;
  const rolesModifierAddress = role.rolesModifierAddress as `0x${string}`;
  const multiSendAddress = getSafeContracts(chainId).multiSendCallOnly;
  const roleKey = role.roleKey as `0x${string}`;

  const { rpcManager, rpcUrl } = await buildFailoverRpcManager(chainId);
  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  const context: TransactionContext = {
    organizationId,
    executionId: `safe-roles-update-${generateId()}`,
    chainId,
    rpcUrl,
    rpcManager,
  };

  try {
    // ----- Build DESIRED state -----
    const {
      protocolSlugs: desiredSlugs,
      allowedTokenSymbols: desiredTokenSymbols,
      allowances: desiredAllowancesFlat,
    } = flattenInstallInput(protocolInputs, directRules);

    const {
      permissions: desiredProtocolPermissions,
      applied: appliedProtocols,
      skipped: skippedProtocols,
    } = await buildPermissionsForProtocols({
      chainId,
      safeAddress,
      protocols: desiredSlugs,
      allowedTokenSymbols: desiredTokenSymbols,
    });

    const desiredDirectRulePermissions: Permission[] = [];
    const skippedDirectRules: string[] = [];
    for (const rule of directRules) {
      const allowanceKey = buildDirectRuleAllowanceKey(roleKey, rule);
      const permission = buildDirectRulePermission(rule, allowanceKey);
      if (permission) {
        desiredDirectRulePermissions.push(permission);
      } else {
        skippedDirectRules.push(
          `${rule.kind} ${rule.tokenSymbol} -> ${rule.counterparty}`
        );
      }
    }
    const desiredPermissions: Permission[] = [
      ...desiredProtocolPermissions,
      ...desiredDirectRulePermissions,
    ];
    const desiredRole: Role = buildDesiredRole({
      roleKey,
      delegate: ownerAddress as `0x${string}`,
      permissions: desiredPermissions,
    });

    // ----- Reconstruct CURRENT state from DB cache -----
    // Only protocols can be reconstructed faithfully (templateSlug + tokens
    // are deterministic). Direct rule conditions aren't stored, so the diff
    // will treat them as new -- the modifier's idempotent scopeFunction
    // call absorbs the no-op gas hit.
    const activeCurrentProtocols = currentProtocolRows.filter(
      (p) =>
        p.status === "allowed" && p.protocolSlug !== DIRECT_RULE_PROTOCOL_SLUG
    );
    const currentSlugs = activeCurrentProtocols.map((p) => p.protocolSlug);
    const currentTokenSymbols = Array.from(
      new Set(activeCurrentProtocols.flatMap((p) => p.allowedTokenSymbols))
    );
    const { permissions: currentProtocolPermissions } =
      await buildPermissionsForProtocols({
        chainId,
        safeAddress,
        protocols: currentSlugs,
        allowedTokenSymbols: currentTokenSymbols,
      });

    // Pull current direct rules out of the dedicated table and rebuild
    // their Permission[] so the SDK diff can correctly revoke any rule
    // the admin removed in the wizard. Without this the diff only sees
    // ADDs and lingering scopes stay on chain forever.
    const currentDirectRuleRows = await listRoleDirectRules(role.id);
    const currentDirectRulePermissions: Permission[] = [];
    for (const stored of currentDirectRuleRows) {
      if (stored.status !== "allowed") {
        continue;
      }
      const ruleShape = {
        kind: stored.kind as DirectRuleInput["kind"],
        tokenAddress: stored.tokenAddress,
        tokenSymbol: stored.tokenSymbol,
        tokenDecimals: stored.tokenDecimals,
        counterparty: stored.counterparty,
        amountHuman: stored.amountHuman,
        periodSeconds: stored.periodSeconds,
      } satisfies DirectRuleInput;
      const allowanceKey = buildDirectRuleAllowanceKey(roleKey, ruleShape);
      const permission = buildDirectRulePermission(ruleShape, allowanceKey);
      if (permission) {
        currentDirectRulePermissions.push(permission);
      }
    }

    const currentRole: Role = buildDesiredRole({
      roleKey,
      delegate: ownerAddress as `0x${string}`,
      permissions: [
        ...currentProtocolPermissions,
        ...currentDirectRulePermissions,
      ],
    });

    // ----- Diff scope calls (SDK) -----
    const scopeCalls = callsPlannedForApplyRole(currentRole, desiredRole);
    const encodedScopeCalls = encodeCalls(scopeCalls, rolesModifierAddress);

    // ----- Diff allowance buckets (manual) -----
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const desiredAllowancesWithKeys = desiredAllowancesFlat.map((a) => ({
      ...a,
      allowanceKey: resolveAllowanceKey(roleKey, a),
    }));
    const allowanceDiff = diffAllowances(
      currentAllowanceRows,
      desiredAllowancesWithKeys,
      nowSec
    );

    if (encodedScopeCalls.length === 0 && allowanceDiff.setCalls.length === 0) {
      return {
        success: true,
        role,
        protocols: currentProtocolRows,
        allowances: currentAllowanceRows,
        applied: appliedProtocols,
        skipped: skippedProtocols,
        skippedDirectRules,
        noChanges: true,
        addedProtocols: 0,
        removedProtocols: 0,
        addedAllowances: 0,
        changedAllowances: 0,
        revokedAllowances: 0,
      };
    }

    // ----- Wrap in MultiSend → Safe.execTransaction -----
    const multiSendCalls: MultiSendCall[] = [];
    for (const call of encodedScopeCalls) {
      multiSendCalls.push({
        to: call.to,
        data: call.data,
        value: BigInt(0),
        operation: 0,
      });
    }
    for (const call of allowanceDiff.setCalls) {
      multiSendCalls.push({
        to: rolesModifierAddress,
        data: call.data,
        value: BigInt(0),
        operation: 0,
      });
    }

    const multiSendCalldata = buildMultiSendCalldata(multiSendCalls);
    const outerCalldata = buildExecTransactionCalldata({
      to: multiSendAddress,
      data: multiSendCalldata,
      value: BigInt(0),
      operation: 1,
      ownerAddress,
    });

    const updateResult = await withNonceSession(
      context,
      ownerAddress,
      (session) =>
        executeTransaction(
          context,
          ownerAddress,
          () => ({
            to: safeAddress,
            data: outerCalldata,
            value: BigInt(0),
            chainId,
          }),
          session
        )
    );

    if (!(updateResult.success && updateResult.receipt)) {
      throw new Error(updateResult.error ?? "Role update tx reverted");
    }

    const updateTxHash = updateResult.txHash ?? null;

    // ----- Persist DB delta in one transaction -----
    const persistResult = await db.transaction(async (tx) => {
      const desiredSlugSet = new Set(appliedProtocols);
      const directRuleNeeded = directRules.some(
        (r) => directRuleSelector(r.kind) !== null
      );

      // Mark removed protocols as revoked (preserves audit trail).
      const removedSlugs: string[] = [];
      for (const p of activeCurrentProtocols) {
        if (!desiredSlugSet.has(p.protocolSlug)) {
          removedSlugs.push(p.protocolSlug);
          await tx
            .update(safeRoleProtocols)
            .set({ status: "revoked", lastUpdatedAt: new Date() })
            .where(eq(safeRoleProtocols.id, p.id));
        }
      }
      // Direct rule synthetic protocol row: revoke if no direct rules now.
      if (!directRuleNeeded) {
        for (const p of currentProtocolRows) {
          if (
            p.protocolSlug === DIRECT_RULE_PROTOCOL_SLUG &&
            p.status === "allowed"
          ) {
            await tx
              .update(safeRoleProtocols)
              .set({ status: "revoked", lastUpdatedAt: new Date() })
              .where(eq(safeRoleProtocols.id, p.id));
          }
        }
      }

      // Upsert applied protocols.
      const protocolRows: SafeRoleProtocol[] = [];
      for (const slug of appliedProtocols) {
        const catalog = PROTOCOL_CATALOG[slug as keyof typeof PROTOCOL_CATALOG];
        if (!catalog) {
          continue;
        }
        const [row] = await tx
          .insert(safeRoleProtocols)
          .values({
            roleId: role.id,
            protocolSlug: slug,
            templateSlug: catalog.templateSlug,
            allowedTokenSymbols: desiredTokenSymbols,
            targetAddresses: [],
            allowedSelectors: [],
            status: "allowed",
            lastAppliedTxHash: updateTxHash,
          })
          .onConflictDoUpdate({
            target: [safeRoleProtocols.roleId, safeRoleProtocols.protocolSlug],
            set: {
              templateSlug: catalog.templateSlug,
              allowedTokenSymbols: desiredTokenSymbols,
              status: "allowed",
              lastAppliedTxHash: updateTxHash,
              lastUpdatedAt: new Date(),
            },
          })
          .returning();
        protocolRows.push(row);
      }

      // Direct rule synthetic protocol row.
      if (directRuleNeeded) {
        const selectors: string[] = Array.from(
          new Set(
            directRules
              .map((r) => directRuleSelector(r.kind))
              .filter((s): s is `0x${string}` => s !== null)
          )
        );
        await tx
          .insert(safeRoleProtocols)
          .values({
            roleId: role.id,
            protocolSlug: DIRECT_RULE_PROTOCOL_SLUG,
            templateSlug: "direct",
            allowedTokenSymbols: desiredTokenSymbols,
            targetAddresses: [],
            allowedSelectors: selectors,
            status: "allowed",
            lastAppliedTxHash: updateTxHash,
          })
          .onConflictDoUpdate({
            target: [safeRoleProtocols.roleId, safeRoleProtocols.protocolSlug],
            set: {
              templateSlug: "direct",
              allowedTokenSymbols: desiredTokenSymbols,
              allowedSelectors: selectors,
              status: "allowed",
              lastAppliedTxHash: updateTxHash,
              lastUpdatedAt: new Date(),
            },
          });
      }

      // Per-rule direct rule rows: upsert each desired rule, then delete
      // any DB row for this role that's not in the desired set (the
      // user removed it through the wizard).
      const desiredRuleKeys = new Set<string>();
      for (const rule of directRules) {
        if (!rule.counterparty) {
          continue;
        }
        const normalizedCounterparty = ethers.isAddress(rule.counterparty)
          ? ethers.getAddress(rule.counterparty)
          : rule.counterparty;
        const normalizedTokenAddress = rule.tokenAddress
          ? normalizeAddressForStorage(rule.tokenAddress)
          : NATIVE_TOKEN_SENTINEL;
        desiredRuleKeys.add(
          `${rule.kind}|${normalizedTokenAddress}|${normalizedCounterparty}`
        );
        await tx
          .insert(safeRoleDirectRules)
          .values({
            roleId: role.id,
            kind: rule.kind,
            tokenAddress: normalizedTokenAddress,
            tokenSymbol: rule.tokenSymbol,
            tokenDecimals: rule.tokenDecimals,
            counterparty: normalizedCounterparty,
            amountHuman: rule.amountHuman,
            periodSeconds: rule.periodSeconds,
            status: "allowed",
            lastAppliedTxHash: updateTxHash,
          })
          .onConflictDoUpdate({
            target: [
              safeRoleDirectRules.roleId,
              safeRoleDirectRules.kind,
              safeRoleDirectRules.tokenAddress,
              safeRoleDirectRules.counterparty,
            ],
            set: {
              tokenSymbol: rule.tokenSymbol,
              tokenDecimals: rule.tokenDecimals,
              amountHuman: rule.amountHuman,
              periodSeconds: rule.periodSeconds,
              status: "allowed",
              lastAppliedTxHash: updateTxHash,
              lastUpdatedAt: new Date(),
            },
          });
      }
      const existingRuleRows = await tx
        .select()
        .from(safeRoleDirectRules)
        .where(eq(safeRoleDirectRules.roleId, role.id));
      for (const existing of existingRuleRows) {
        const key = `${existing.kind}|${existing.tokenAddress}|${existing.counterparty}`;
        if (!desiredRuleKeys.has(key)) {
          await tx
            .delete(safeRoleDirectRules)
            .where(eq(safeRoleDirectRules.id, existing.id));
        }
      }

      // Upsert allowances. For each desired bucket, write the row. For
      // each chain-revoked bucket, drop the DB row to mirror the on-chain
      // zeroing (keeping it would mislead the UI).
      const allowanceRows: SafeRoleAllowance[] = [];
      const desiredKeySet = new Set(
        desiredAllowancesWithKeys.map((d) => d.allowanceKey.toLowerCase())
      );
      for (const a of desiredAllowancesWithKeys) {
        const [row] = await tx
          .insert(safeRoleAllowances)
          .values({
            roleId: role.id,
            protocolSlug: a.protocolSlug,
            allowanceKey: a.allowanceKey,
            tokenAddress: a.tokenAddress,
            tokenSymbol: a.tokenSymbol,
            tokenDecimals: a.tokenDecimals,
            maxRefillWei: a.maxRefillWei,
            refillWei: a.refillWei,
            periodSeconds: a.periodSeconds,
            lastChainBalanceWei: a.maxRefillWei,
            lastChainTimestamp: new Date(Number(nowSec) * 1000),
            lastReconciledAt: new Date(),
            lastAppliedTxHash: updateTxHash,
          })
          .onConflictDoUpdate({
            target: [
              safeRoleAllowances.roleId,
              safeRoleAllowances.allowanceKey,
            ],
            set: {
              protocolSlug: a.protocolSlug,
              tokenAddress: a.tokenAddress,
              tokenSymbol: a.tokenSymbol,
              tokenDecimals: a.tokenDecimals,
              maxRefillWei: a.maxRefillWei,
              refillWei: a.refillWei,
              periodSeconds: a.periodSeconds,
              lastChainBalanceWei: a.maxRefillWei,
              lastChainTimestamp: new Date(Number(nowSec) * 1000),
              lastReconciledAt: new Date(),
              lastAppliedTxHash: updateTxHash,
              lastUpdatedAt: new Date(),
            },
          })
          .returning();
        allowanceRows.push(row);
      }
      for (const c of currentAllowanceRows) {
        if (!desiredKeySet.has(c.allowanceKey.toLowerCase())) {
          await tx
            .delete(safeRoleAllowances)
            .where(eq(safeRoleAllowances.id, c.id));
        }
      }

      const refreshedAllowances = await tx
        .select()
        .from(safeRoleAllowances)
        .where(eq(safeRoleAllowances.roleId, role.id));
      const refreshedProtocols = await tx
        .select()
        .from(safeRoleProtocols)
        .where(eq(safeRoleProtocols.roleId, role.id));

      return {
        protocolRows: refreshedProtocols,
        allowanceRows: refreshedAllowances,
        removedSlugs,
      };
    });

    return {
      success: true,
      role,
      protocols: persistResult.protocolRows,
      allowances: persistResult.allowanceRows,
      applied: appliedProtocols,
      skipped: skippedProtocols,
      skippedDirectRules,
      noChanges: false,
      addedProtocols:
        appliedProtocols.length - persistResult.removedSlugs.length > 0
          ? appliedProtocols.filter(
              (s) => !activeCurrentProtocols.some((p) => p.protocolSlug === s)
            ).length
          : 0,
      removedProtocols: persistResult.removedSlugs.length,
      addedAllowances: allowanceDiff.added,
      changedAllowances: allowanceDiff.changed,
      revokedAllowances: allowanceDiff.revoked,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Zodiac Roles update failed for org=${organizationId} chain=${chainId}`,
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: chainId.toString(),
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Per-token allowance CRUD (delta-only on-chain tx)
// ---------------------------------------------------------------------------

/**
 * Set or update a single token allowance on an already-installed Role.
 * Emits exactly one on-chain tx: Safe.execTransaction → modifier.setAllowance.
 */
export async function setRoleTokenAllowance(
  input: SetAllowanceInput
): Promise<SetAllowanceResult> {
  const { organizationId, chainId } = input;

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return { success: false, error: "Safe not found for this chain" };
  }
  const role = await findRoleForSafe(safe.id);
  if (role?.status !== "active") {
    return {
      success: false,
      error: "Install Zodiac Roles before setting spending limits",
    };
  }

  if (!ethers.isAddress(input.tokenAddress)) {
    return {
      success: false,
      error: `Invalid token address: ${input.tokenAddress}`,
    };
  }
  const normalizedToken = normalizeAddressForStorage(input.tokenAddress);
  const { symbol, decimals } = resolveTokenMetadata(
    chainId,
    normalizedToken,
    input.tokenSymbol,
    input.tokenDecimals
  );

  if (!input.protocolSlug) {
    return {
      success: false,
      error: "protocolSlug is required to set a per-protocol allowance",
    };
  }

  const allowanceKey = tokenAllowanceKey(
    role.roleKey,
    input.protocolSlug,
    normalizedToken
  ) as `0x${string}`;
  const maxRefill = BigInt(input.maxRefillWei);
  const refill = BigInt(input.refillWei);
  if (maxRefill <= BigInt(0)) {
    return {
      success: false,
      error: "maxRefillWei must be greater than zero",
    };
  }
  if (refill > maxRefill) {
    return {
      success: false,
      error: "refillWei must not exceed maxRefillWei",
    };
  }

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const { rpcManager, rpcUrl } = await buildFailoverRpcManager(chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  const context: TransactionContext = {
    organizationId,
    executionId: `safe-roles-allowance-set-${generateId()}`,
    chainId,
    rpcUrl,
    rpcManager,
  };

  try {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const innerCalldata = buildSetAllowanceCalldata({
      allowanceKey,
      balance: maxRefill,
      maxRefill,
      refill,
      period: BigInt(input.periodSeconds),
      timestamp: nowSec,
    });
    const outerCalldata = buildExecTransactionCalldata({
      to: role.rolesModifierAddress,
      data: innerCalldata,
      value: BigInt(0),
      operation: 0,
      ownerAddress,
    });

    const result = await withNonceSession(context, ownerAddress, (session) =>
      executeTransaction(
        context,
        ownerAddress,
        () => ({
          to: safe.safeAddress,
          data: outerCalldata,
          value: BigInt(0),
          chainId,
        }),
        session
      )
    );

    if (!result.success) {
      throw new Error(result.error ?? "setAllowance tx reverted");
    }

    const [row] = await db
      .insert(safeRoleAllowances)
      .values({
        roleId: role.id,
        protocolSlug: input.protocolSlug,
        allowanceKey,
        tokenAddress: normalizedToken,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        maxRefillWei: input.maxRefillWei,
        refillWei: input.refillWei,
        periodSeconds: input.periodSeconds,
        lastChainBalanceWei: input.maxRefillWei,
        lastChainTimestamp: new Date(Number(nowSec) * 1000),
        lastReconciledAt: new Date(),
        lastAppliedTxHash: result.txHash ?? null,
      })
      .onConflictDoUpdate({
        target: [safeRoleAllowances.roleId, safeRoleAllowances.allowanceKey],
        set: {
          protocolSlug: input.protocolSlug,
          tokenAddress: normalizedToken,
          maxRefillWei: input.maxRefillWei,
          refillWei: input.refillWei,
          periodSeconds: input.periodSeconds,
          lastChainBalanceWei: input.maxRefillWei,
          lastChainTimestamp: new Date(Number(nowSec) * 1000),
          lastReconciledAt: new Date(),
          lastAppliedTxHash: result.txHash ?? null,
          lastUpdatedAt: new Date(),
          tokenSymbol: symbol,
          tokenDecimals: decimals,
        },
      })
      .returning();

    return { success: true, allowance: row };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Role setAllowance failed for org=${organizationId} token=${normalizedToken}`,
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: chainId.toString(),
        token: normalizedToken,
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Revoke a per-token allowance. Sets the on-chain allowance to zero with a
 * zero refill period (effectively disabling it) and deletes the DB row.
 */
export async function revokeRoleTokenAllowance(input: {
  organizationId: string;
  chainId: number;
  protocolSlug: string;
  tokenAddress: string;
}): Promise<
  | { success: true; deleted: SafeRoleAllowance }
  | { success: false; error: string }
> {
  const { organizationId, chainId, protocolSlug, tokenAddress } = input;
  if (!ethers.isAddress(tokenAddress)) {
    return { success: false, error: `Invalid token address: ${tokenAddress}` };
  }
  if (!protocolSlug) {
    return {
      success: false,
      error: "protocolSlug is required to revoke a per-protocol allowance",
    };
  }

  const safe = await findSafeForOrg(organizationId, chainId);
  if (!safe) {
    return { success: false, error: "Safe not found" };
  }
  const role = await findRoleForSafe(safe.id);
  if (role?.status !== "active") {
    return { success: false, error: "No active role for this Safe" };
  }

  const normalizedToken = normalizeAddressForStorage(tokenAddress);
  const allowanceKey = tokenAllowanceKey(
    role.roleKey,
    protocolSlug,
    normalizedToken
  ) as `0x${string}`;

  const ownerWallet = await getOrganizationWallet(organizationId);
  const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);
  const { rpcManager, rpcUrl } = await buildFailoverRpcManager(chainId);

  await initializeWalletSigner(organizationId, rpcUrl, chainId);

  const context: TransactionContext = {
    organizationId,
    executionId: `safe-roles-allowance-revoke-${generateId()}`,
    chainId,
    rpcUrl,
    rpcManager,
  };

  try {
    const innerCalldata = buildSetAllowanceCalldata({
      allowanceKey,
      balance: BigInt(0),
      maxRefill: BigInt(0),
      refill: BigInt(0),
      period: BigInt(0),
      timestamp: BigInt(0),
    });
    const outerCalldata = buildExecTransactionCalldata({
      to: role.rolesModifierAddress,
      data: innerCalldata,
      value: BigInt(0),
      operation: 0,
      ownerAddress,
    });

    const result = await withNonceSession(context, ownerAddress, (session) =>
      executeTransaction(
        context,
        ownerAddress,
        () => ({
          to: safe.safeAddress,
          data: outerCalldata,
          value: BigInt(0),
          chainId,
        }),
        session
      )
    );
    if (!result.success) {
      throw new Error(result.error ?? "revoke tx reverted");
    }

    const [deleted] = await db
      .delete(safeRoleAllowances)
      .where(
        and(
          eq(safeRoleAllowances.roleId, role.id),
          eq(safeRoleAllowances.protocolSlug, protocolSlug),
          eq(safeRoleAllowances.tokenAddress, normalizedToken)
        )
      )
      .returning();

    if (!deleted) {
      return {
        success: false,
        error: "Allowance zeroed on-chain but DB row was already missing",
      };
    }
    return { success: true, deleted };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      "[Safe] Role revokeAllowance failed",
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: chainId.toString(),
        token: normalizedToken,
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Read helpers (list state)
// ---------------------------------------------------------------------------

export async function getSafeRole(
  safeWalletId: string
): Promise<SafeRole | null> {
  return await findRoleForSafe(safeWalletId);
}

/**
 * Cheap RPC probe that answers "does this Safe currently have a Roles
 * modifier enabled on chain?" in one paginated module read. Used by the
 * GET-time backfill to decide whether to spend a full reconcile pass on a
 * Safe whose DB cache says "uninstalled."
 *
 * Returns null if the Safe's modules can't be read (RPC outage, chain not
 * configured) or no enabled module declares this Safe as its avatar.
 */
async function probeRolesModifierOnChain(
  safe: SafeWallet
): Promise<string | null> {
  try {
    const { rpcManager } = await buildFailoverRpcManager(safe.chainId);
    const modules = await rpcManager.executeWithFailover((provider) =>
      readEnabledSafeModules(provider, safe.safeAddress)
    );
    if (modules.length === 0) {
      return null;
    }
    return await rpcManager.executeWithFailover((provider) =>
      findRolesModifierForSafe(provider, safe.safeAddress, modules)
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] probe Roles modifier failed for safe=${safe.id}`,
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: safe.chainId.toString(),
      }
    );
    return null;
  }
}

/**
 * Load a Safe's role plus its protocols and allowances. Wraps the raw
 * read with two recovery paths so the UI never hides on-chain state behind
 * a stale or empty DB cache:
 *
 * 1. **Empty cache, existing role row** -- DB has a `safe_roles` row but no
 *    protocols / allowances. Run `reconcileSafeRoleFromChain` to rehydrate
 *    from the modifier's `allowances(...)` view.
 *
 * 2. **No DB role row at all** -- the silent-write bug case, or any case
 *    where someone enabled a Roles modifier on the Safe outside the wizard.
 *    A cheap one-RPC probe asks "is there a Roles modifier on chain?" If
 *    yes, run a full reconcile which inserts the role row + protocols +
 *    allowances. The reconcile is idempotent via the
 *    `(safeWalletId, roleType)` unique index, so concurrent calls cannot
 *    produce duplicate rows.
 *
 * Reconcile is best-effort: if any RPC step fails we return whatever's in
 * the DB so the page still renders, and the user can retry from the
 * explicit Sync button on the role card.
 */
export async function getSafeRoleWithBackfill(safe: SafeWallet): Promise<{
  role: SafeRole | null;
  protocols: SafeRoleProtocol[];
  allowances: SafeRoleAllowance[];
  directRules: SafeRoleDirectRule[];
}> {
  const role = await findRoleForSafe(safe.id);

  if (!role) {
    const onChainModifier = await probeRolesModifierOnChain(safe);
    if (!onChainModifier) {
      return { role: null, protocols: [], allowances: [], directRules: [] };
    }
    try {
      const reconciled = await reconcileSafeRoleFromChain(safe);
      if (reconciled.success && reconciled.installed) {
        const directRules = await listRoleDirectRules(reconciled.role.id);
        return {
          role: reconciled.role,
          protocols: reconciled.protocols,
          allowances: reconciled.allowances,
          directRules,
        };
      }
    } catch (error) {
      logSystemError(
        ErrorCategory.TRANSACTION,
        `[Safe] auto-backfill reconcile (no-role-row) failed for safe=${safe.id}`,
        error,
        {
          component: "safe-roles-orchestrator",
          chain_id: safe.chainId.toString(),
        }
      );
    }
    return { role: null, protocols: [], allowances: [], directRules: [] };
  }

  const [protocols, allowances, directRules] = await Promise.all([
    listRoleProtocols(role.id),
    listRoleAllowances(role.id),
    listRoleDirectRules(role.id),
  ]);

  if (protocols.length > 0 || allowances.length > 0) {
    return { role, protocols, allowances, directRules };
  }

  try {
    const reconciled = await reconcileSafeRoleFromChain(safe);
    if (reconciled.success && reconciled.installed) {
      const refreshed = await listRoleDirectRules(role.id);
      return {
        role: reconciled.role,
        protocols: reconciled.protocols,
        allowances: reconciled.allowances,
        directRules: refreshed,
      };
    }
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] auto-backfill reconcile failed for safe=${safe.id}`,
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: safe.chainId.toString(),
      }
    );
  }
  return { role, protocols, allowances, directRules };
}

export async function listRoleProtocols(
  roleId: string
): Promise<SafeRoleProtocol[]> {
  return await db
    .select()
    .from(safeRoleProtocols)
    .where(eq(safeRoleProtocols.roleId, roleId));
}

export async function listRoleAllowances(
  roleId: string
): Promise<SafeRoleAllowance[]> {
  return await db
    .select()
    .from(safeRoleAllowances)
    .where(eq(safeRoleAllowances.roleId, roleId));
}

export async function listRoleDirectRules(
  roleId: string
): Promise<SafeRoleDirectRule[]> {
  return await db
    .select()
    .from(safeRoleDirectRules)
    .where(eq(safeRoleDirectRules.roleId, roleId));
}

const ERC20_TRANSFER_SELECTOR_LOWER = "0xa9059cbb" as const;
const ERC20_APPROVE_SELECTOR_LOWER = "0x095ea7b3" as const;

function findEqualToAddressInTree(condition: Condition): string | null {
  if (
    condition.operator === Operator.EqualTo &&
    condition.paramType === ParameterType.Static &&
    condition.compValue
  ) {
    const hex = condition.compValue.slice(-40);
    if (hex.length === 40) {
      try {
        return ethers.getAddress(`0x${hex}`);
      } catch {
        return null;
      }
    }
  }
  for (const child of condition.children ?? []) {
    const found = findEqualToAddressInTree(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function humanFromWei(wei: string, decimals: number): string {
  try {
    const big = BigInt(wei);
    if (decimals === 0) {
      return big.toString();
    }
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = big / divisor;
    const fraction = big % divisor;
    if (fraction === BigInt(0)) {
      return whole.toString();
    }
    const fractionStr = fraction
      .toString()
      .padStart(decimals, "0")
      .replace(TRAILING_ZEROS_REGEX, "");
    return `${whole}.${fractionStr}`.replace(TRAILING_DOT_REGEX, "");
  } catch {
    return wei;
  }
}

type ExtractedDirectRule = {
  kind: "erc20-transfer" | "erc20-approve";
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  counterparty: string;
  amountHuman: string;
  periodSeconds: number;
};

/**
 * Discriminated result so callers can distinguish "subgraph returned no
 * direct rules" (chain is genuinely empty) from "subgraph could not be
 * reached" (we don't know what's on chain). The write paths use this to
 * avoid Jacob's destructive-update scenario: an update that runs reconcile
 * first, gets empty rules back due to a subgraph outage, then strips the
 * modifier's direct-rule scope on chain because the diff says "remove
 * everything we don't know about". See review #923-r2.
 */
type ExtractDirectRulesResult =
  | { ok: true; rules: ExtractedDirectRule[] }
  | { ok: false; reason: "subgraph_unreachable" | "subgraph_returned_null" };

async function extractDirectRulesFromChain(
  chainId: number,
  modifierAddress: string,
  roleKey: string,
  knownAllowances: SafeRoleAllowance[]
): Promise<ExtractDirectRulesResult> {
  let role: Awaited<ReturnType<typeof fetchRole>>;
  try {
    role = await fetchRole({
      chainId: chainId as ChainId,
      address: modifierAddress as `0x${string}`,
      roleKey: roleKey as `0x${string}`,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] subgraph fetchRole failed for chain=${chainId} modifier=${modifierAddress}`,
      error,
      { component: "safe-roles-orchestrator", chain_id: chainId.toString() }
    );
    return { ok: false, reason: "subgraph_unreachable" };
  }
  if (!role) {
    return { ok: false, reason: "subgraph_returned_null" };
  }

  const allowanceByToken = new Map<string, SafeRoleAllowance>();
  for (const a of knownAllowances) {
    if (a.protocolSlug === DIRECT_RULE_PROTOCOL_SLUG) {
      allowanceByToken.set(a.tokenAddress.toLowerCase(), a);
    }
  }

  const extracted: ExtractedDirectRule[] = [];
  for (const target of role.targets) {
    const tokenAddressLower = target.address.toLowerCase();
    for (const fn of target.functions) {
      const selector = fn.selector.toLowerCase();
      const isTransfer = selector === ERC20_TRANSFER_SELECTOR_LOWER;
      const isApprove = selector === ERC20_APPROVE_SELECTOR_LOWER;
      if (!(isTransfer || isApprove)) {
        continue;
      }
      if (!fn.condition) {
        continue;
      }
      const counterparty = findEqualToAddressInTree(fn.condition);
      if (!counterparty) {
        continue;
      }
      const allowance = allowanceByToken.get(tokenAddressLower);
      const tokenInfo = getTokenInfo(chainId, tokenAddressLower);
      const tokenSymbol =
        allowance?.tokenSymbol ?? tokenInfo?.symbol ?? "UNKNOWN";
      const tokenDecimals =
        allowance?.tokenDecimals ?? tokenInfo?.decimals ?? 18;
      const periodSeconds = allowance?.periodSeconds ?? 0;
      const amountHuman = allowance
        ? humanFromWei(allowance.maxRefillWei, tokenDecimals)
        : "0";
      extracted.push({
        kind: isTransfer ? "erc20-transfer" : "erc20-approve",
        tokenAddress: ethers.getAddress(target.address),
        tokenSymbol,
        tokenDecimals,
        counterparty,
        amountHuman,
        periodSeconds,
      });
    }
  }
  return { ok: true, rules: extracted };
}

// ---------------------------------------------------------------------------
// Reconcile: rebuild the DB cache from authoritative on-chain Roles state
// ---------------------------------------------------------------------------

/**
 * Result of a reconcile pass. Surfaced to the API so the UI can show what
 * actually changed (e.g. "imported 2 buckets from chain" vs "no drift").
 */
export type ReconcileSafeRoleResult =
  | {
      success: true;
      installed: false;
      reason: "no-roles-modifier";
    }
  | {
      success: true;
      installed: true;
      role: SafeRole;
      protocols: SafeRoleProtocol[];
      allowances: SafeRoleAllowance[];
      /** Buckets discovered on chain that the DB did not have */
      addedAllowances: number;
      /** Buckets the DB had whose on-chain bytes differ from cached values */
      updatedAllowances: number;
      /** Buckets in DB whose on-chain `maxRefill` is now zero */
      staleAllowances: number;
      /**
       * True if the Zodiac subgraph could not be reached during this
       * reconcile. Direct-rule details (kind, counterparty) come from the
       * subgraph, so when this is set the DB direct-rule cache is whatever
       * was there before this pass (we don't delete on failure). The write
       * paths use this to refuse updates that would otherwise compute a
       * diff against stale state. See review #923-r2.
       */
      subgraphUnreachable: boolean;
    }
  | { success: false; error: string };

type ReconcileProbe = {
  protocolSlug: string;
  templateSlug: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  allowanceKey: `0x${string}`;
};

/**
 * Build the set of `(protocol, token)` candidates whose on-chain allowance
 * bucket is worth probing. We union three sources:
 *
 *  1. Every chain-supported protocol in the catalog × the protocol's default
 *     token list. Covers the wizard's most common installs.
 *  2. The synthetic `direct` slug × every well-known token on this chain.
 *     Covers ERC-20 direct rules where the admin picked any popular token.
 *  3. Any allowance row already in the DB. Preserves custom tokens an admin
 *     entered manually that are absent from the registry.
 *
 * The probe set is bounded (a handful of dozen entries) so a reconcile fits
 * in well under a second of RPC time even on mainnet.
 */
function buildReconcileProbeSet(
  chainId: number,
  roleKey: string,
  existingAllowances: SafeRoleAllowance[],
  existingDirectRules: SafeRoleDirectRule[]
): ReconcileProbe[] {
  const seen = new Set<string>();
  const probes: ReconcileProbe[] = [];

  const push = (probe: ReconcileProbe): void => {
    const key = probe.allowanceKey.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    probes.push(probe);
  };

  // (1) catalog × per-protocol default tokens
  for (const slug of Object.keys(PROTOCOL_CATALOG)) {
    const catalog = PROTOCOL_CATALOG[slug as keyof typeof PROTOCOL_CATALOG];
    if (!catalog?.chainIds.includes(chainId)) {
      continue;
    }
    const defaults = resolveDefaultTokensForProtocol(
      slug as ProtocolSlug,
      chainId
    );
    for (const token of defaults) {
      const tokenAddress = normalizeAddressForStorage(token.address);
      push({
        protocolSlug: slug,
        templateSlug: catalog.templateSlug,
        tokenAddress,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        allowanceKey: tokenAllowanceKey(
          roleKey,
          slug,
          tokenAddress
        ) as `0x${string}`,
      });
    }
  }

  // (2) per-direct-rule buckets. Each row in safe_role_direct_rules has its
  // own bucket via directRuleAllowanceKey(kind, counterparty, token); we
  // can't probe the synthetic (direct, token) shape because it does not
  // correspond to any on-chain key.
  for (const rule of existingDirectRules) {
    if (!rule.tokenAddress) {
      continue;
    }
    const tokenAddress = normalizeAddressForStorage(rule.tokenAddress);
    push({
      protocolSlug: DIRECT_RULE_PROTOCOL_SLUG,
      templateSlug: "direct",
      tokenAddress,
      tokenSymbol: rule.tokenSymbol,
      tokenDecimals: rule.tokenDecimals,
      allowanceKey: directRuleAllowanceKey(
        roleKey,
        rule.kind,
        rule.counterparty,
        tokenAddress
      ) as `0x${string}`,
    });
  }

  // (3) anything already in DB (preserves custom tokens not in the registry).
  // Reuse the stored allowanceKey directly so direct-rule rows keep their
  // per-rule key without us needing kind/counterparty here.
  for (const allowance of existingAllowances) {
    push({
      protocolSlug: allowance.protocolSlug,
      templateSlug:
        allowance.protocolSlug === DIRECT_RULE_PROTOCOL_SLUG
          ? "direct"
          : (PROTOCOL_CATALOG[
              allowance.protocolSlug as keyof typeof PROTOCOL_CATALOG
            ]?.templateSlug ?? "unknown"),
      tokenAddress: allowance.tokenAddress,
      tokenSymbol: allowance.tokenSymbol,
      tokenDecimals: allowance.tokenDecimals,
      allowanceKey: allowance.allowanceKey as `0x${string}`,
    });
  }

  return probes;
}

/**
 * Reconcile the DB cache with on-chain Roles modifier state for one Safe.
 *
 * Recovers from the silent-write bug where the orchestrator's on-chain tx
 * confirmed but the DB writes after the receipt failed (FK timing, dropped
 * connection, etc). Probes a bounded set of candidate `(protocol, token)`
 * allowance buckets via RPC and upserts every bucket the modifier reports
 * with a non-zero `maxRefill`. Buckets whose on-chain `maxRefill` is now
 * zero get their cache columns refreshed (`lastChainBalanceWei = "0"`,
 * `lastReconciledAt = now`) but the row is preserved for audit.
 *
 * If the Safe no longer has any Roles modifier enabled, the existing
 * `safeRoles` row (if any) is marked `revoked` and the function returns
 * `installed: false`.
 */
export async function reconcileSafeRoleFromChain(
  safe: SafeWallet
): Promise<ReconcileSafeRoleResult> {
  try {
    // Reconcile is a read-only path called from both the workflow-write
    // backfill (silent-write recovery) and the "Refresh from chain" admin
    // button. Route every chain read through executeWithFailover so a
    // transient primary-RPC outage falls back to the chain's fallback URL
    // rather than failing the reconcile and (in the workflow case)
    // downgrading the write to the unscoped `safe.execTransaction` path.
    // See review #923-r2 (MEDIUM).
    const { rpcManager } = await buildFailoverRpcManager(safe.chainId);

    const enabledModules = await rpcManager.executeWithFailover(
      (rpcProvider) => readEnabledSafeModules(rpcProvider, safe.safeAddress),
      "preflight"
    );
    const rolesModifierAddress = await rpcManager.executeWithFailover(
      (rpcProvider) =>
        findRolesModifierForSafe(rpcProvider, safe.safeAddress, enabledModules),
      "preflight"
    );

    if (!rolesModifierAddress) {
      const existingRole = await findRoleForSafe(safe.id);
      if (existingRole && existingRole.status !== "revoked") {
        await db
          .update(safeRoles)
          .set({ status: "revoked", updatedAt: new Date() })
          .where(eq(safeRoles.id, existingRole.id));
      }
      return { success: true, installed: false, reason: "no-roles-modifier" };
    }

    const roleKey = orgAutomationRoleKey(
      safe.organizationId,
      safe.chainId
    ) as `0x${string}`;
    const ownerWallet = await getOrganizationWallet(safe.organizationId);
    const ownerAddress = normalizeAddressForStorage(ownerWallet.walletAddress);

    const existingRole = await findRoleForSafe(safe.id);
    const existingAllowances = existingRole
      ? await listRoleAllowances(existingRole.id)
      : [];
    const existingDirectRules = existingRole
      ? await listRoleDirectRules(existingRole.id)
      : [];

    const probes = buildReconcileProbeSet(
      safe.chainId,
      roleKey,
      existingAllowances,
      existingDirectRules
    );

    type ProbeReadResult = {
      probe: ReconcileProbe;
      allowanceKey: `0x${string}`;
      onChain: OnChainAllowance;
    };
    const reads: ProbeReadResult[] = [];
    for (const probe of probes) {
      const { allowanceKey } = probe;
      try {
        const onChain = await rpcManager.executeWithFailover(
          (rpcProvider) =>
            readRoleAllowance(rpcProvider, rolesModifierAddress, allowanceKey),
          "preflight"
        );
        reads.push({ probe, allowanceKey, onChain });
      } catch (probeError) {
        logSystemError(
          ErrorCategory.TRANSACTION,
          `[Safe] reconcile allowance read failed for safe=${safe.id} key=${allowanceKey}`,
          probeError,
          {
            component: "safe-roles-orchestrator",
            chain_id: safe.chainId.toString(),
          }
        );
      }
    }

    // delegateAddress: on first install we record the current owner EOA.
    // On a reconcile of an existing role we preserve the stored value
    // because chain-side `assignRoles` was bound to whatever the EOA was
    // at install time; rotating the org wallet must NOT silently rewrite
    // this column to the new EOA or the DB drifts from chain enforcement.
    // See review #923-r2 (MEDIUM).
    const persistedDelegateAddress =
      existingRole?.delegateAddress ?? ownerAddress;
    const persistResult = await db.transaction(async (tx) => {
      const [roleRow] = await tx
        .insert(safeRoles)
        .values({
          safeWalletId: safe.id,
          roleType: ROLE_TYPE_AUTOMATION,
          roleKey,
          rolesModifierAddress:
            normalizeAddressForStorage(rolesModifierAddress),
          delegateAddress: persistedDelegateAddress,
          installedTxHash: existingRole?.installedTxHash ?? null,
          lastReconciledAt: new Date(),
          status: "active",
        })
        .onConflictDoUpdate({
          target: [safeRoles.safeWalletId, safeRoles.roleType],
          set: {
            roleKey,
            rolesModifierAddress:
              normalizeAddressForStorage(rolesModifierAddress),
            // Intentionally NOT overwriting delegateAddress here.
            lastReconciledAt: new Date(),
            status: "active",
            updatedAt: new Date(),
          },
        })
        .returning();

      const cachedByKey = new Map<string, SafeRoleAllowance>();
      for (const row of existingAllowances) {
        cachedByKey.set(row.allowanceKey.toLowerCase(), row);
      }

      const protocolSlugsToWrite = new Set<string>();
      let addedAllowances = 0;
      let updatedAllowances = 0;
      let staleAllowances = 0;
      const reconciliationTimestamp = new Date();

      for (const { probe, allowanceKey, onChain } of reads) {
        const existing = cachedByKey.get(allowanceKey.toLowerCase());
        const onChainExists = onChain.maxRefill > BigInt(0);

        if (!(onChainExists || existing)) {
          continue;
        }

        if (onChainExists) {
          protocolSlugsToWrite.add(probe.protocolSlug);
        }

        const maxRefillWei = onChain.maxRefill.toString();
        const refillWei = onChain.refill.toString();
        const lastChainBalanceWei = onChain.balance.toString();
        const periodSeconds = Number(onChain.period);
        const lastChainTimestamp =
          onChain.timestamp > BigInt(0)
            ? new Date(Number(onChain.timestamp) * 1000)
            : reconciliationTimestamp;

        if (!existing) {
          if (!onChainExists) {
            continue;
          }
          await tx.insert(safeRoleAllowances).values({
            roleId: roleRow.id,
            protocolSlug: probe.protocolSlug,
            allowanceKey,
            tokenAddress: probe.tokenAddress,
            tokenSymbol: probe.tokenSymbol,
            tokenDecimals: probe.tokenDecimals,
            maxRefillWei,
            refillWei,
            periodSeconds,
            lastChainBalanceWei,
            lastChainTimestamp,
            lastReconciledAt: reconciliationTimestamp,
          });
          addedAllowances += 1;
          continue;
        }

        const driftedConfig =
          existing.maxRefillWei !== maxRefillWei ||
          existing.refillWei !== refillWei ||
          existing.periodSeconds !== periodSeconds;
        const driftedCache =
          existing.lastChainBalanceWei !== lastChainBalanceWei;

        if (!onChainExists) {
          staleAllowances += 1;
          await tx
            .update(safeRoleAllowances)
            .set({
              lastChainBalanceWei: "0",
              lastReconciledAt: reconciliationTimestamp,
              lastUpdatedAt: reconciliationTimestamp,
            })
            .where(eq(safeRoleAllowances.id, existing.id));
          continue;
        }

        if (driftedConfig || driftedCache) {
          updatedAllowances += 1;
          await tx
            .update(safeRoleAllowances)
            .set({
              maxRefillWei,
              refillWei,
              periodSeconds,
              lastChainBalanceWei,
              lastChainTimestamp,
              lastReconciledAt: reconciliationTimestamp,
              lastUpdatedAt: reconciliationTimestamp,
            })
            .where(eq(safeRoleAllowances.id, existing.id));
        } else {
          await tx
            .update(safeRoleAllowances)
            .set({
              lastReconciledAt: reconciliationTimestamp,
            })
            .where(eq(safeRoleAllowances.id, existing.id));
        }
      }

      // Upsert protocol rows for every slug that has at least one live
      // allowance bucket. This is what the wizard installs alongside the
      // setAllowance call, so seeing buckets implies the protocol was applied.
      for (const slug of protocolSlugsToWrite) {
        const isDirect = slug === DIRECT_RULE_PROTOCOL_SLUG;
        const catalog = isDirect
          ? null
          : PROTOCOL_CATALOG[slug as keyof typeof PROTOCOL_CATALOG];
        const templateSlug = isDirect
          ? "direct"
          : (catalog?.templateSlug ?? "unknown");
        const symbolsForSlug = reads
          .filter(({ probe }) => probe.protocolSlug === slug)
          .map(({ probe }) => probe.tokenSymbol);
        const uniqueSymbols = Array.from(new Set(symbolsForSlug));
        await tx
          .insert(safeRoleProtocols)
          .values({
            roleId: roleRow.id,
            protocolSlug: slug,
            templateSlug,
            allowedTokenSymbols: uniqueSymbols,
            targetAddresses: [],
            allowedSelectors: [],
            status: "allowed",
          })
          .onConflictDoUpdate({
            target: [safeRoleProtocols.roleId, safeRoleProtocols.protocolSlug],
            set: {
              templateSlug,
              allowedTokenSymbols: uniqueSymbols,
              status: "allowed",
              lastUpdatedAt: reconciliationTimestamp,
            },
          });
      }

      const protocolRows = await tx
        .select()
        .from(safeRoleProtocols)
        .where(eq(safeRoleProtocols.roleId, roleRow.id));
      const allowanceRows = await tx
        .select()
        .from(safeRoleAllowances)
        .where(eq(safeRoleAllowances.roleId, roleRow.id));

      return {
        roleRow,
        protocolRows,
        allowanceRows,
        addedAllowances,
        updatedAllowances,
        staleAllowances,
      };
    });

    // Pull per-rule details (kind + counterparty) from the Zodiac subgraph
    // and upsert them so the Direct rules section in the UI shows concrete
    // recipient/spender info, not just bucket caps. Best-effort: subgraph
    // outages or chains without a Roles subgraph just skip this step.
    const extractResult = await extractDirectRulesFromChain(
      safe.chainId,
      rolesModifierAddress,
      roleKey,
      persistResult.allowanceRows
    );
    // Treat BOTH failure modes as "subgraph cannot tell us what the
    // modifier holds": fetch failure (subgraph_unreachable) and a null
    // response (subgraph_returned_null, e.g. indexer lag where the role
    // hasn't been observed yet). In either case the on-chain modifier may
    // still hold direct-rule scopes we don't see; the write paths must
    // refuse to compute a diff that would silently strip them. The
    // benign "no direct rules anywhere" case is detected upstream in
    // updateRolesConfig (existing + desired both empty -> proceed).
    const subgraphUnreachable = !extractResult.ok;
    const extractedDirectRules = extractResult.ok ? extractResult.rules : [];
    if (extractedDirectRules.length > 0) {
      await db.transaction(async (tx) => {
        for (const rule of extractedDirectRules) {
          const normalizedTokenAddress = normalizeAddressForStorage(
            rule.tokenAddress
          );
          await tx
            .insert(safeRoleDirectRules)
            .values({
              roleId: persistResult.roleRow.id,
              kind: rule.kind,
              tokenAddress: normalizedTokenAddress,
              tokenSymbol: rule.tokenSymbol,
              tokenDecimals: rule.tokenDecimals,
              counterparty: rule.counterparty,
              amountHuman: rule.amountHuman,
              periodSeconds: rule.periodSeconds,
              status: "allowed",
            })
            .onConflictDoUpdate({
              target: [
                safeRoleDirectRules.roleId,
                safeRoleDirectRules.kind,
                safeRoleDirectRules.tokenAddress,
                safeRoleDirectRules.counterparty,
              ],
              set: {
                tokenSymbol: rule.tokenSymbol,
                tokenDecimals: rule.tokenDecimals,
                amountHuman: rule.amountHuman,
                periodSeconds: rule.periodSeconds,
                status: "allowed",
                lastUpdatedAt: new Date(),
              },
            });
        }
      });
    }

    return {
      success: true,
      installed: true,
      role: persistResult.roleRow,
      protocols: persistResult.protocolRows,
      allowances: persistResult.allowanceRows,
      addedAllowances: persistResult.addedAllowances,
      updatedAllowances: persistResult.updatedAllowances,
      staleAllowances: persistResult.staleAllowances,
      subgraphUnreachable,
    };
  } catch (error) {
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] Zodiac Roles reconcile failed for safe=${safe.id} chain=${safe.chainId}`,
      error,
      {
        component: "safe-roles-orchestrator",
        chain_id: safe.chainId.toString(),
      }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
