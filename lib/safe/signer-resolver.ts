import "server-only";

import { and, eq } from "drizzle-orm";
import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import type { SafeWallet } from "@/lib/db/schema";
import { safeRoles, safeWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  recordSignerMode,
  recordSignerProbeFailure,
} from "@/lib/metrics/instrumentation/safe";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";
// reconcileSafeRoleFromChain is dynamically imported below to keep the
// roles-orchestrator (and its defi-kit transitive dep, which proxies the
// entire SDK at module load) out of the import graph for routes that only
// need the signer-mode resolution. Static imports here pull defi-kit into
// every API route that does a workflow write, which trips a recursive
// mapSdk overflow during Next.js page-data collection.
import { orgAutomationRoleKey } from "@/lib/safe/zodiac-contracts";
import {
  findRolesModifierForSafe,
  readEnabledSafeModules,
} from "@/lib/safe/zodiac-roles";
import {
  getOrganizationWallet,
  getOrganizationWalletAddress,
} from "@/lib/web3/wallet-helpers";

/**
 * Resolution result: which mode should a workflow write on this (org, chain)
 * execute in, and what addresses matter.
 *
 * In every mode the Turnkey EOA signs the outer Ethereum tx (nonce on the
 * EOA, gas paid by the EOA). The difference is `msg.sender` at the target
 * contract, and therefore which address needs to hold the funds and receive
 * protocol positions.
 *
 * Modes:
 *   - "eoa"       : Turnkey signs and calls the target directly.
 *   - "safe"      : Safe mode ON but no Zodiac Role is active; writes go via
 *                   owner-signed `safe.execTransaction` (no policy gating).
 *   - "safe-role" : Safe mode ON and a Zodiac Role is applied; writes go via
 *                   `rolesModifier.execTransactionWithRole` so every call is
 *                   validated against the role's scope + allowances.
 */
/**
 * Canonical signer-mode discriminants. Referenced everywhere a mode is built
 * or compared so the bare string literals live in exactly one place.
 */
export const SIGNER_MODE = {
  EOA: "eoa",
  SAFE: "safe",
  SAFE_ROLE: "safe-role",
} as const;

export type SignerModeKind = (typeof SIGNER_MODE)[keyof typeof SIGNER_MODE];

export type SignerMode =
  | {
      kind: typeof SIGNER_MODE.EOA;
      ownerAddress: string;
    }
  | {
      kind: typeof SIGNER_MODE.SAFE;
      ownerAddress: string;
      safeAddress: string;
      safeWalletId: string;
    }
  | {
      kind: typeof SIGNER_MODE.SAFE_ROLE;
      ownerAddress: string;
      safeAddress: string;
      safeWalletId: string;
      rolesModifierAddress: string;
      roleKey: string;
      delegateAddress: string;
    };

/**
 * One-shot chain probe to detect a Roles modifier enabled on a Safe even
 * when our DB has no `safe_roles` row. Used as a recovery path when the
 * install's post-tx DB write dropped a row -- the workflow runner should
 * still route through the modifier rather than silently downgrading to
 * unscoped owner-signed mode.
 *
 * Reads are routed through `RpcProviderManager.executeWithFailover` so a
 * transient primary-RPC outage falls back to the configured secondary
 * endpoint rather than downgrading the workflow to `safe` mode. Returns
 * the modifier's address on success, null otherwise. Errors are only
 * swallowed once *both* primary and fallback have failed; the next
 * reconcile (or the user-triggered Sync button) repairs the DB later.
 */
async function probeRolesModifierFromChain(
  safe: Pick<SafeWallet, "id" | "chainId" | "safeAddress">
): Promise<string | null> {
  try {
    // Deliberately uses the static chain RPC config rather than
    // `resolveRpcConfig(chainId, userId, ...)`. The probe issues stateless
    // `eth_call`s (readEnabledSafeModules, findRolesModifierForSafe) that
    // should not be routed through any user write-side private mempool
    // (Flashbots Protect, custom bundler endpoints, etc.). Those endpoints
    // are not designed to serve reads, and routing them would leak the
    // workflow's resolver-time RPC traffic into the user's private channel.
    // Reads always go to the public/configured chain RPC; user RPC prefs
    // apply only to the broadcast side. See KEEP-566.
    const primaryRpcUrl = getRpcUrlByChainId(safe.chainId, "primary");
    const fallbackRpcUrl = getRpcUrlByChainId(safe.chainId, "fallback");
    const rpcManager = await getRpcProviderFromUrls(
      primaryRpcUrl,
      fallbackRpcUrl === primaryRpcUrl ? undefined : fallbackRpcUrl,
      safe.chainId
    );
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
    // KEEP-567: probe hit both-RPC failure. We currently swallow and let
    // the caller downgrade to unscoped `safe` mode (policy enforcement
    // gone for the window). Emit a counter so the silent-downgrade
    // frequency is observable before deciding whether to hard-fail the
    // resolver instead. Logged via logSystemError (Sentry) AND the
    // signer_probe.failure counter (dashboards).
    recordSignerProbeFailure({ chainId: safe.chainId });
    logSystemError(
      ErrorCategory.TRANSACTION,
      `[Safe] signer-resolver chain probe failed for safe=${safe.id}`,
      error,
      {
        component: "safe-signer-resolver",
        chain_id: safe.chainId.toString(),
      }
    );
    return null;
  }
}

/**
 * Kick off a background reconcile that backfills the DB cache. Errors are
 * logged and swallowed; we don't surface them to the caller because the
 * routing decision has already been made and the modifier on chain is the
 * source of truth for enforcement either way.
 *
 * Implemented as a normal function rather than `void promise` so the
 * useless-void lint rule stays happy and the intent reads clearly at the
 * call site.
 */
function backfillRoleInBackground(safe: SafeWallet): void {
  import("@/lib/safe/roles-orchestrator")
    .then(({ reconcileSafeRoleFromChain }) => reconcileSafeRoleFromChain(safe))
    .then(
      () => {
        // success path: nothing to do, the DB row is now in place.
      },
      (error: unknown) => {
        logSystemError(
          ErrorCategory.TRANSACTION,
          `[Safe] background reconcile after probe failed for safe=${safe.id}`,
          error,
          {
            component: "safe-signer-resolver",
            chain_id: safe.chainId.toString(),
          }
        );
      }
    );
}

/**
 * Decide whether a workflow write on (orgId, chainId) should execute from
 * the Turnkey EOA directly (default) or route through the Safe.
 *
 * Routing is DB-first for speed (a single SQL query in the steady state),
 * but recovers from cache drift on the way down:
 *
 *   - DB has an active `safe_roles` row -> route through `execTransactionWithRole`.
 *     The modifier on chain is the source of truth for enforcement -- if our
 *     row is wrong (e.g. modifier was disabled out-of-band) the tx reverts
 *     loudly rather than silently bypassing the role.
 *
 *   - DB has no role row but Safe is deployed + signing is active -> probe
 *     chain once. If a Roles modifier is enabled, route through `safe-role`
 *     using the chain-probed modifier address and fire a background reconcile
 *     so the DB catches up. Closes the silent-write hole that previously
 *     downgraded these workflows to unscoped owner-signed `execTransaction`.
 *
 *   - Otherwise -> plain `safe` mode (signing on, no role) or `eoa` mode
 *     (signing off, or no Safe at all).
 */
export async function resolveSignerMode(
  organizationId: string,
  chainId: number,
  options: { recordMetrics?: boolean } = {}
): Promise<SignerMode> {
  const mode = await resolveSignerModeImpl(organizationId, chainId);
  // KEEP-568: emit a single resolver-level counter so dashboards can track
  // the eoa / safe / safe-role distribution. The per-tx `safe.tx.*` counter
  // only sees the two Safe branches; this one also covers EOA. Editor
  // preflight calls opt out so they do not inflate production execution data.
  if (options.recordMetrics !== false) {
    recordSignerMode({ kind: mode.kind, chainId });
  }
  return mode;
}

async function resolveSignerModeImpl(
  organizationId: string,
  chainId: number
): Promise<SignerMode> {
  const ownerAddress = normalizeAddressForStorage(
    await getOrganizationWalletAddress(organizationId)
  );

  const rows = await db
    .select({
      id: safeWallets.id,
      safeAddress: safeWallets.safeAddress,
      status: safeWallets.status,
      isSigningActive: safeWallets.isSigningActive,
    })
    .from(safeWallets)
    .where(
      and(
        eq(safeWallets.organizationId, organizationId),
        eq(safeWallets.chainId, chainId)
      )
    )
    .limit(1);

  const safe = rows[0];
  if (!safe) {
    return { kind: SIGNER_MODE.EOA, ownerAddress };
  }
  if (safe.status !== "deployed" || !safe.isSigningActive) {
    return { kind: SIGNER_MODE.EOA, ownerAddress };
  }

  // Check whether an active Zodiac Role is installed for this Safe. If so,
  // every workflow write routes through `execTransactionWithRole` so the
  // modifier can enforce scope + allowances. If not, fall back to plain
  // owner-signed `execTransaction` (policy gating unavailable).
  const roleRows = await db
    .select({
      rolesModifierAddress: safeRoles.rolesModifierAddress,
      roleKey: safeRoles.roleKey,
      delegateAddress: safeRoles.delegateAddress,
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

  const role = roleRows[0];
  if (role && role.status === "active") {
    return {
      kind: SIGNER_MODE.SAFE_ROLE,
      ownerAddress,
      safeAddress: safe.safeAddress,
      safeWalletId: safe.id,
      rolesModifierAddress: role.rolesModifierAddress,
      roleKey: role.roleKey,
      delegateAddress: role.delegateAddress,
    };
  }

  // No DB role row, but signing is active. The wizard could have installed
  // a modifier on chain whose post-tx DB write dropped (silent-write hole),
  // or someone enabled the modifier on safe.global manually. Probe chain
  // once and route through `safe-role` if a modifier is found.
  const probedModifier = await probeRolesModifierFromChain({
    id: safe.id,
    chainId,
    safeAddress: safe.safeAddress,
  });
  if (probedModifier) {
    // Backfill the DB so future executions skip the probe. We don't await:
    // the modifier on chain enforces the role regardless of our cache, so
    // the routing decision is safe to make before the cache is rehydrated.
    const safeForReconcile: SafeWallet = {
      id: safe.id,
      organizationId,
      chainId,
      safeAddress: safe.safeAddress,
      status: safe.status,
      isSigningActive: safe.isSigningActive,
    } as SafeWallet;
    backfillRoleInBackground(safeForReconcile);

    return {
      kind: SIGNER_MODE.SAFE_ROLE,
      ownerAddress,
      safeAddress: safe.safeAddress,
      safeWalletId: safe.id,
      rolesModifierAddress: normalizeAddressForStorage(probedModifier),
      roleKey: orgAutomationRoleKey(organizationId, chainId),
      delegateAddress: ownerAddress,
    };
  }

  return {
    kind: SIGNER_MODE.SAFE,
    ownerAddress,
    safeAddress: safe.safeAddress,
    safeWalletId: safe.id,
  };
}

/**
 * Convenience wrapper: returns the owning Turnkey wallet row AND the signer
 * mode in a single resolution. Callers that already need the wallet row
 * (e.g. to obtain the ethers Signer) can avoid a second DB hit.
 */
export async function resolveWalletAndSignerMode(
  organizationId: string,
  chainId: number
): Promise<{
  ownerWallet: Awaited<ReturnType<typeof getOrganizationWallet>>;
  signerMode: SignerMode;
}> {
  const [ownerWallet, signerMode] = await Promise.all([
    getOrganizationWallet(organizationId),
    resolveSignerMode(organizationId, chainId),
  ]);
  return { ownerWallet, signerMode };
}

/**
 * Per-node Web3 Connection field, as persisted on `WorkflowNode.config.web3Connection`.
 *
 * Format:
 *   - undefined | "default" : delegate to org policy (`resolveSignerMode`)
 *   - "eoa"                  : force the Turnkey EOA, even if the org Safe is
 *                              the default. Bypasses Zodiac Roles policy gating.
 *   - "safe:<safeWalletId>"  : pin a specific Safe row. Resolver validates the
 *                              Safe belongs to the org, is deployed, and lives
 *                              on the same chain as the node.
 *
 * Two-segment string keeps the field human-inspectable in `workflows.nodes`
 * JSONB and lint-friendly (no nested objects) without sacrificing typing.
 */
export type ParsedWeb3Connection =
  | { kind: "default" }
  | { kind: typeof SIGNER_MODE.EOA }
  | { kind: typeof SIGNER_MODE.SAFE; safeWalletId: string };

export function parseWeb3Connection(
  value: string | null | undefined
): ParsedWeb3Connection {
  if (!value || value === "default") {
    return { kind: "default" };
  }
  if (value === SIGNER_MODE.EOA) {
    return { kind: SIGNER_MODE.EOA };
  }
  if (value.startsWith("safe:")) {
    const safeWalletId = value.slice("safe:".length);
    if (safeWalletId.length === 0) {
      throw new Error(
        `Invalid web3Connection value '${value}': safe id is empty`
      );
    }
    return { kind: SIGNER_MODE.SAFE, safeWalletId };
  }
  throw new Error(`Invalid web3Connection value '${value}'`);
}

type ResolveSignerForNodeInput = {
  organizationId: string;
  chainId: number;
  web3Connection?: string | null;
  recordMetrics?: boolean;
};

/**
 * Per-node signer resolution. Looks at the node's `web3Connection` field and:
 *
 *   - "default" / missing -> delegates to `resolveSignerMode` (org-policy path).
 *   - "eoa"               -> short-circuits to EOA mode. The org Safe (and its
 *                             Zodiac Role, if any) is intentionally bypassed.
 *   - "safe:<id>"         -> validates the Safe (same org, same chain, deployed),
 *                             then resolves its role state the same way the
 *                             policy path does. If a Roles modifier is active
 *                             (DB row or chain probe) the resolver upgrades to
 *                             `safe-role`; otherwise it returns plain `safe`.
 *
 * The "safe-role auto-upgrade" matches `resolveSignerModeImpl` behaviour so a
 * node pinned to a Safe still enforces policy when one is installed, without
 * exposing a separate "Safe with Role" UI option (per ticket design).
 */
export async function resolveSignerForNode(
  input: ResolveSignerForNodeInput
): Promise<SignerMode> {
  const parsed = parseWeb3Connection(input.web3Connection);

  if (parsed.kind === "default") {
    return resolveSignerMode(input.organizationId, input.chainId, {
      recordMetrics: input.recordMetrics,
    });
  }

  if (parsed.kind === SIGNER_MODE.EOA) {
    const ownerAddress = normalizeAddressForStorage(
      await getOrganizationWalletAddress(input.organizationId)
    );
    if (input.recordMetrics !== false) {
      recordSignerMode({ kind: SIGNER_MODE.EOA, chainId: input.chainId });
    }
    return { kind: SIGNER_MODE.EOA, ownerAddress };
  }

  // safe:<id>
  const rows = await db
    .select({
      id: safeWallets.id,
      organizationId: safeWallets.organizationId,
      chainId: safeWallets.chainId,
      safeAddress: safeWallets.safeAddress,
      status: safeWallets.status,
      isSigningActive: safeWallets.isSigningActive,
    })
    .from(safeWallets)
    .where(eq(safeWallets.id, parsed.safeWalletId))
    .limit(1);

  const safe = rows[0];
  if (!safe) {
    throw new Error(
      `web3Connection refers to unknown Safe '${parsed.safeWalletId}'`
    );
  }
  if (safe.organizationId !== input.organizationId) {
    throw new Error(
      `web3Connection refers to a Safe '${parsed.safeWalletId}' that does not belong to this organization`
    );
  }
  if (safe.chainId !== input.chainId) {
    throw new Error(
      `web3Connection Safe '${parsed.safeWalletId}' is on chain ${safe.chainId}, but this node runs on chain ${input.chainId}`
    );
  }
  if (safe.status !== "deployed") {
    throw new Error(
      `web3Connection Safe '${parsed.safeWalletId}' is not deployed yet (status=${safe.status})`
    );
  }

  const ownerAddress = normalizeAddressForStorage(
    await getOrganizationWalletAddress(input.organizationId)
  );

  // Mirror the role lookup in resolveSignerModeImpl so a pinned Safe still
  // routes through `execTransactionWithRole` when a Roles modifier is active.
  const roleRows = await db
    .select({
      rolesModifierAddress: safeRoles.rolesModifierAddress,
      roleKey: safeRoles.roleKey,
      delegateAddress: safeRoles.delegateAddress,
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

  const role = roleRows[0];
  if (role && role.status === "active") {
    if (input.recordMetrics !== false) {
      recordSignerMode({ kind: SIGNER_MODE.SAFE_ROLE, chainId: input.chainId });
    }
    return {
      kind: SIGNER_MODE.SAFE_ROLE,
      ownerAddress,
      safeAddress: safe.safeAddress,
      safeWalletId: safe.id,
      rolesModifierAddress: role.rolesModifierAddress,
      roleKey: role.roleKey,
      delegateAddress: role.delegateAddress,
    };
  }

  const probedModifier = await probeRolesModifierFromChain({
    id: safe.id,
    chainId: input.chainId,
    safeAddress: safe.safeAddress,
  });
  if (probedModifier) {
    const safeForReconcile: SafeWallet = {
      id: safe.id,
      organizationId: safe.organizationId,
      chainId: safe.chainId,
      safeAddress: safe.safeAddress,
      status: safe.status,
      isSigningActive: safe.isSigningActive,
    } as SafeWallet;
    backfillRoleInBackground(safeForReconcile);
    if (input.recordMetrics !== false) {
      recordSignerMode({ kind: SIGNER_MODE.SAFE_ROLE, chainId: input.chainId });
    }
    return {
      kind: SIGNER_MODE.SAFE_ROLE,
      ownerAddress,
      safeAddress: safe.safeAddress,
      safeWalletId: safe.id,
      rolesModifierAddress: normalizeAddressForStorage(probedModifier),
      roleKey: orgAutomationRoleKey(input.organizationId, input.chainId),
      delegateAddress: ownerAddress,
    };
  }

  if (input.recordMetrics !== false) {
    recordSignerMode({ kind: SIGNER_MODE.SAFE, chainId: input.chainId });
  }
  return {
    kind: SIGNER_MODE.SAFE,
    ownerAddress,
    safeAddress: safe.safeAddress,
    safeWalletId: safe.id,
  };
}
