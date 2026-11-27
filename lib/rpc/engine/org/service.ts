import "server-only";

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/db/errors";
import { workflows } from "@/lib/db/schema";
import {
  type OrganizationRpcConfigRow,
  organizationRpcChainPolicy,
  organizationRpcConfigs,
} from "@/lib/db/schema-rpc";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { actionRpcNetworkKey } from "@/lib/workflow/rpc-selection-field";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";
import { findActionById } from "@/plugins/registry";
import { platformRpcSource } from "../runtime";
import {
  loadOrgRpcConfigs,
  loadOwnRpcOnlyChains,
} from "../sources/db-org-source";
import type { PlatformChainRecord } from "../sources/platform-source";
import type { OrgRpcConfig } from "../types";
import {
  decodeRpcConfigUrls,
  encodeRpcConfigUrls,
  filledUrlSlots,
  orgRpcConfigFromRow,
  orgRpcConfigFromUrls,
} from "./codec";
import { OrgRpcErrorCode } from "./codes";

/**
 * Where an action keeps the network it calls over RPC, from its plugin
 * definition. Unknown action types are read at the usual key, so coverage
 * errs on the safe side.
 */
function actionTypeNetworkKey(actionType: string): string | null {
  const action = findActionById(actionType);
  return action
    ? actionRpcNetworkKey(action.configFields)
    : DEFAULT_NETWORK_CONFIG_KEY;
}

import {
  type CoverageGap,
  type CoverageWorkflow,
  chainUsagesOf,
  DEFAULT_NETWORK_CONFIG_KEY,
  findCoverageGaps,
  type NodeChainUsage,
} from "./coverage";
import {
  RPC_CONFIG_URL_SLOTS,
  RpcConfigUrlSlot,
  type RpcConfigUrls,
  type RpcConfigVerification,
} from "./url-slots";
import { verifyRpcConfigUrls } from "./verify";

export { OrgRpcErrorCode } from "./codes";

const ERROR_STATUS: Readonly<Record<OrgRpcErrorCode, number>> = {
  [OrgRpcErrorCode.INVALID_INPUT]: 400,
  [OrgRpcErrorCode.CHAIN_UNAVAILABLE]: 400,
  [OrgRpcErrorCode.NOT_FOUND]: 404,
  [OrgRpcErrorCode.NAME_TAKEN]: 409,
  [OrgRpcErrorCode.VERIFICATION_FAILED]: 422,
  [OrgRpcErrorCode.COVERAGE_GAPS]: 409,
};

export type OrgRpcFailure = {
  ok: false;
  status: number;
  code: OrgRpcErrorCode;
  message: string;
  verification?: RpcConfigVerification;
  gaps?: CoverageGap[];
};

export type OrgRpcResult<T> = ({ ok: true } & T) | OrgRpcFailure;

function failure(
  code: OrgRpcErrorCode,
  message: string,
  extra: Pick<OrgRpcFailure, "verification" | "gaps"> = {}
): OrgRpcFailure {
  return { ok: false, status: ERROR_STATUS[code], code, message, ...extra };
}

/**
 * What any member may see about a config. Holds nothing derived from a URL:
 * not the URL, a part of it, or its host. Only which slots are set.
 */
export type OrgRpcConfigView = {
  id: string;
  chainId: number;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  slots: RpcConfigUrlSlot[];
  /** True when the stored URLs cannot be decrypted; they must be re-entered. */
  unreadable: boolean;
  verification: RpcConfigVerification;
  createdAt: string;
  updatedAt: string;
};

/** The stored URLs, or null when they cannot be decrypted. */
function readUrls(row: OrganizationRpcConfigRow): RpcConfigUrls | null {
  try {
    return decodeRpcConfigUrls(row.encryptedUrls);
  } catch (error) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[RPC Engine] Could not decrypt an organization RPC config",
      error,
      { organization_id: row.organizationId, config_id: row.id }
    );
    return null;
  }
}

function toView(row: OrganizationRpcConfigRow): OrgRpcConfigView {
  const urls = readUrls(row);
  return {
    id: row.id,
    chainId: row.chainId,
    name: row.name,
    isDefault: row.isDefault,
    enabled: row.enabled,
    slots: urls ? filledUrlSlots(urls) : [],
    unreadable: urls === null,
    verification: row.verification,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listOrgRpcConfigs(
  organizationId: string
): Promise<OrgRpcConfigView[]> {
  const rows = await db
    .select()
    .from(organizationRpcConfigs)
    .where(eq(organizationRpcConfigs.organizationId, organizationId))
    .orderBy(organizationRpcConfigs.chainId, organizationRpcConfigs.name);
  return rows.map(toView);
}

async function findRow(
  organizationId: string,
  configId: string
): Promise<OrganizationRpcConfigRow | undefined> {
  const [row] = await db
    .select()
    .from(organizationRpcConfigs)
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, organizationId),
        eq(organizationRpcConfigs.id, configId)
      )
    )
    .limit(1);
  return row;
}

async function loadEnabledChain(
  chainId: number
): Promise<PlatformChainRecord | null> {
  const record = await platformRpcSource.load(chainId);
  return record?.chain.isEnabled ? record : null;
}

// Coverage ------------------------------------------------------------------

async function loadOrgUsages(
  organizationId: string
): Promise<NodeChainUsage[]> {
  const rows = await db
    .select({ id: workflows.id, name: workflows.name, nodes: workflows.nodes })
    .from(workflows)
    .where(
      and(eq(workflows.organizationId, organizationId), workflowNotDeleted())
    );
  return rows.flatMap((row) => chainUsagesOf(row, actionTypeNetworkKey));
}

async function loadPlatformRecords(
  usages: readonly NodeChainUsage[]
): Promise<Map<number, PlatformChainRecord>> {
  const chainIds = [...new Set(usages.map((usage) => usage.chainId))];
  const records = await Promise.all(
    chainIds.map((chainId) => platformRpcSource.load(chainId))
  );
  const byChain = new Map<number, PlatformChainRecord>();
  for (const record of records) {
    if (record) {
      byChain.set(record.chain.chainId, record);
    }
  }
  return byChain;
}

type CoverageState = {
  ownRpcOnlyChains: ReadonlySet<number>;
  configs: readonly OrgRpcConfig[];
};

function gapKey(gap: CoverageGap): string {
  return JSON.stringify([gap.workflowId, gap.nodeId, gap.chainId, gap.code]);
}

/**
 * Gaps the proposed state would open that the current state does not have.
 * Gaps a workflow already has are not blamed on the change being made.
 */
async function newCoverageGaps(
  organizationId: string,
  current: CoverageState,
  proposed: CoverageState
): Promise<CoverageGap[]> {
  const usages = await loadOrgUsages(organizationId);
  if (usages.length === 0) {
    return [];
  }
  const platform = await loadPlatformRecords(usages);
  const before = new Set(
    findCoverageGaps({ organizationId, usages, platform, ...current }).map(
      gapKey
    )
  );
  return findCoverageGaps({
    organizationId,
    usages,
    platform,
    ...proposed,
  }).filter((gap) => !before.has(gapKey(gap)));
}

/** Every node the organization's policy currently leaves uncovered. */
export async function currentCoverageGaps(
  organizationId: string
): Promise<CoverageGap[]> {
  const usages = await loadOrgUsages(organizationId);
  if (usages.length === 0) {
    return [];
  }
  const [ownRpcOnlyChains, configs, platform] = await Promise.all([
    loadOwnRpcOnlyChains(organizationId),
    loadOrgRpcConfigs(organizationId),
    loadPlatformRecords(usages),
  ]);
  return findCoverageGaps({
    organizationId,
    usages,
    platform,
    ownRpcOnlyChains,
    configs,
  });
}

/**
 * Nodes of one workflow that its organization's RPC setup leaves without a
 * route, counting only gaps from a pinned config or own RPC only. With
 * `previousNodes`, gaps the stored version already has are left out, so a
 * save is refused only for what it changes.
 */
export async function workflowCoverageGaps(
  organizationId: string,
  workflow: CoverageWorkflow,
  previousNodes?: unknown
): Promise<CoverageGap[]> {
  const usages = chainUsagesOf(workflow, actionTypeNetworkKey);
  if (usages.length === 0) {
    return [];
  }
  const [ownRpcOnlyChains, configs, platform] = await Promise.all([
    loadOwnRpcOnlyChains(organizationId),
    loadOrgRpcConfigs(organizationId),
    loadPlatformRecords(usages),
  ]);
  const state = { organizationId, platform, ownRpcOnlyChains, configs };
  const gaps = findCoverageGaps({ ...state, usages });
  if (gaps.length === 0 || previousNodes === undefined) {
    return gaps;
  }
  const before = new Set(
    findCoverageGaps({
      ...state,
      usages: chainUsagesOf(
        { ...workflow, nodes: previousNodes },
        actionTypeNetworkKey
      ),
    }).map(gapKey)
  );
  return gaps.filter((gap) => !before.has(gapKey(gap)));
}

/** The refusal for a workflow save or check that leaves nodes without a route. */
export async function workflowCoverageRefusal(
  organizationId: string,
  workflow: CoverageWorkflow,
  previousNodes?: unknown
): Promise<OrgRpcFailure | null> {
  const gaps = await workflowCoverageGaps(
    organizationId,
    workflow,
    previousNodes
  );
  return gaps.length > 0
    ? failure(
        OrgRpcErrorCode.COVERAGE_GAPS,
        "Some steps would have no RPC endpoint to use. Pick an RPC config for each one listed.",
        { gaps }
      )
    : null;
}

async function refuseNewGaps(
  organizationId: string,
  proposeConfigs: (configs: OrgRpcConfig[]) => OrgRpcConfig[],
  message: string
): Promise<OrgRpcFailure | null> {
  const [ownRpcOnlyChains, configs] = await Promise.all([
    loadOwnRpcOnlyChains(organizationId),
    loadOrgRpcConfigs(organizationId),
  ]);
  const gaps = await newCoverageGaps(
    organizationId,
    { ownRpcOnlyChains, configs },
    { ownRpcOnlyChains, configs: proposeConfigs(configs) }
  );
  return gaps.length > 0
    ? failure(OrgRpcErrorCode.COVERAGE_GAPS, message, { gaps })
    : null;
}

// Configs -------------------------------------------------------------------

/** Stands in for a config's id in a coverage check before it is inserted. */
const PROPOSED_CONFIG_ID = "proposed";

export type CreateOrgRpcConfigInput = {
  organizationId: string;
  userId: string;
  chainId: number;
  name: string;
  urls: RpcConfigUrls;
  isDefault?: boolean;
  enabled?: boolean;
};

async function hasDefault(
  organizationId: string,
  chainId: number,
  excludeId?: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationRpcConfigs.id })
    .from(organizationRpcConfigs)
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, organizationId),
        eq(organizationRpcConfigs.chainId, chainId),
        eq(organizationRpcConfigs.isDefault, true),
        excludeId ? ne(organizationRpcConfigs.id, excludeId) : undefined
      )
    )
    .limit(1);
  return Boolean(row);
}

function clearOtherDefaults(
  tx: Pick<typeof db, "update">,
  organizationId: string,
  chainId: number,
  keepId: string
): Promise<unknown> {
  return tx
    .update(organizationRpcConfigs)
    .set({ isDefault: false })
    .where(
      and(
        eq(organizationRpcConfigs.organizationId, organizationId),
        eq(organizationRpcConfigs.chainId, chainId),
        eq(organizationRpcConfigs.isDefault, true),
        ne(organizationRpcConfigs.id, keepId)
      )
    );
}

/**
 * Add a config after every URL has answered for its chain. The first config
 * on a chain becomes that chain's default.
 */
export async function createOrgRpcConfig(
  input: CreateOrgRpcConfigInput
): Promise<OrgRpcResult<{ config: OrgRpcConfigView }>> {
  const name = input.name.trim();
  if (name.length === 0) {
    return failure(OrgRpcErrorCode.INVALID_INPUT, "Give the config a name.");
  }
  const record = await loadEnabledChain(input.chainId);
  if (!record) {
    return failure(
      OrgRpcErrorCode.CHAIN_UNAVAILABLE,
      `Chain ${input.chainId} is not supported.`
    );
  }
  const checked = await verifyRpcConfigUrls(input.urls, record.chain);
  if (!checked.ok) {
    return failure(
      OrgRpcErrorCode.VERIFICATION_FAILED,
      "One or more URLs did not pass the check.",
      { verification: checked.verification }
    );
  }

  const enabled = input.enabled ?? true;
  if (input.isDefault && !enabled) {
    return failure(
      OrgRpcErrorCode.INVALID_INPUT,
      "A disabled config cannot be the default."
    );
  }
  const isDefault =
    input.isDefault ??
    (enabled && !(await hasDefault(input.organizationId, input.chainId)));
  if (isDefault) {
    const proposed = orgRpcConfigFromUrls(
      {
        id: PROPOSED_CONFIG_ID,
        name,
        chainId: input.chainId,
        enabled,
        isDefault,
      },
      input.urls
    );
    const refused = await refuseNewGaps(
      input.organizationId,
      (configs) => [
        ...configs.map((config) =>
          config.chainId === input.chainId
            ? { ...config, isDefault: false }
            : config
        ),
        proposed,
      ],
      "Making this config the default would leave workflows without an RPC endpoint."
    );
    if (refused) {
      return refused;
    }
  }
  const encryptedUrls = encodeRpcConfigUrls(input.urls);
  try {
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(organizationRpcConfigs)
        .values({
          organizationId: input.organizationId,
          chainId: input.chainId,
          name,
          isDefault: false,
          enabled,
          encryptedUrls,
          verification: checked.verification,
          createdBy: input.userId,
          updatedBy: input.userId,
        })
        .returning();
      if (!isDefault) {
        return inserted;
      }
      await clearOtherDefaults(
        tx,
        input.organizationId,
        input.chainId,
        inserted.id
      );
      const [promoted] = await tx
        .update(organizationRpcConfigs)
        .set({ isDefault: true })
        .where(eq(organizationRpcConfigs.id, inserted.id))
        .returning();
      return promoted;
    });
    return { ok: true, config: toView(row) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return failure(
        OrgRpcErrorCode.NAME_TAKEN,
        "A config with this name already exists for this chain."
      );
    }
    throw error;
  }
}

/** A URL change per slot: a string replaces it, null removes it. */
export type RpcConfigUrlChanges = Partial<
  Record<RpcConfigUrlSlot, string | null>
>;

export type UpdateOrgRpcConfigInput = {
  organizationId: string;
  userId: string;
  configId: string;
  name?: string;
  enabled?: boolean;
  isDefault?: boolean;
  urls?: RpcConfigUrlChanges;
};

function applyUrlChanges(
  current: Partial<RpcConfigUrls>,
  changes: RpcConfigUrlChanges
): { urls: Partial<RpcConfigUrls>; changed: Partial<RpcConfigUrls> } {
  const urls: Partial<RpcConfigUrls> = { ...current };
  const changed: Partial<RpcConfigUrls> = {};
  for (const slot of RPC_CONFIG_URL_SLOTS) {
    const change = changes[slot];
    if (change === undefined) {
      continue;
    }
    if (change === null) {
      delete urls[slot];
    } else {
      urls[slot] = change;
      changed[slot] = change;
    }
  }
  return { urls, changed };
}

function withoutRemovedChecks(
  verification: RpcConfigVerification,
  urls: Partial<RpcConfigUrls>
): RpcConfigVerification {
  const kept: RpcConfigVerification = {};
  for (const slot of RPC_CONFIG_URL_SLOTS) {
    const check = verification[slot];
    if (urls[slot] && check) {
      kept[slot] = check;
    }
  }
  return kept;
}

/**
 * Change a config. New URLs are checked before anything is saved, and a
 * change that would leave a workflow without a route is refused with the
 * list of affected nodes.
 */
export async function updateOrgRpcConfig(
  input: UpdateOrgRpcConfigInput
): Promise<OrgRpcResult<{ config: OrgRpcConfigView }>> {
  const row = await findRow(input.organizationId, input.configId);
  if (!row) {
    return failure(OrgRpcErrorCode.NOT_FOUND, "RPC config not found.");
  }
  const name = input.name?.trim();
  if (name !== undefined && name.length === 0) {
    return failure(OrgRpcErrorCode.INVALID_INPUT, "Give the config a name.");
  }

  // URLs that can no longer be decrypted are replaced by what is sent now.
  const { urls, changed } = applyUrlChanges(
    readUrls(row) ?? {},
    input.urls ?? {}
  );
  if (!urls[RpcConfigUrlSlot.HTTP_PRIMARY]) {
    return failure(
      OrgRpcErrorCode.INVALID_INPUT,
      "A config needs a primary HTTPS URL."
    );
  }
  const fullUrls = urls as RpcConfigUrls;

  let verification = withoutRemovedChecks(row.verification, urls);
  if (Object.keys(changed).length > 0) {
    const record = await loadEnabledChain(row.chainId);
    if (!record) {
      return failure(
        OrgRpcErrorCode.CHAIN_UNAVAILABLE,
        `Chain ${row.chainId} is not supported.`
      );
    }
    const checked = await verifyRpcConfigUrls(changed, record.chain);
    if (!checked.ok) {
      return failure(
        OrgRpcErrorCode.VERIFICATION_FAILED,
        "One or more URLs did not pass the check.",
        { verification: checked.verification }
      );
    }
    verification = { ...verification, ...checked.verification };
  }

  const enabled = input.enabled ?? row.enabled;
  if (input.isDefault && !enabled) {
    return failure(
      OrgRpcErrorCode.INVALID_INPUT,
      "A disabled config cannot be the default."
    );
  }
  const nextRow: OrganizationRpcConfigRow = {
    ...row,
    name: name ?? row.name,
    enabled,
    // Disabling the default also clears it, so the chain never keeps a
    // default the resolver skips.
    isDefault: enabled && (input.isDefault ?? row.isDefault),
    encryptedUrls: encodeRpcConfigUrls(fullUrls),
    verification,
  };
  const next = orgRpcConfigFromRow(nextRow);
  const refused = await refuseNewGaps(
    input.organizationId,
    (configs) => [
      ...configs
        .filter((config) => config.id !== row.id)
        .map((config) =>
          next.isDefault && config.chainId === next.chainId
            ? { ...config, isDefault: false }
            : config
        ),
      next,
    ],
    "This change would leave workflows without an RPC endpoint."
  );
  if (refused) {
    return refused;
  }

  try {
    const saved = await db.transaction(async (tx) => {
      if (nextRow.isDefault) {
        await clearOtherDefaults(tx, input.organizationId, row.chainId, row.id);
      }
      const [updated] = await tx
        .update(organizationRpcConfigs)
        .set({
          name: nextRow.name,
          enabled: nextRow.enabled,
          isDefault: nextRow.isDefault,
          encryptedUrls: nextRow.encryptedUrls,
          verification,
          updatedBy: input.userId,
          updatedAt: new Date(),
        })
        .where(eq(organizationRpcConfigs.id, row.id))
        .returning();
      return updated;
    });
    return { ok: true, config: toView(saved) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return failure(
        OrgRpcErrorCode.NAME_TAKEN,
        "A config with this name already exists for this chain."
      );
    }
    throw error;
  }
}

export async function deleteOrgRpcConfig(input: {
  organizationId: string;
  configId: string;
}): Promise<OrgRpcResult<{ config: OrgRpcConfigView }>> {
  const row = await findRow(input.organizationId, input.configId);
  if (!row) {
    return failure(OrgRpcErrorCode.NOT_FOUND, "RPC config not found.");
  }
  const refused = await refuseNewGaps(
    input.organizationId,
    (configs) => configs.filter((config) => config.id !== row.id),
    "Deleting this config would leave workflows without an RPC endpoint."
  );
  if (refused) {
    return refused;
  }
  await db
    .delete(organizationRpcConfigs)
    .where(eq(organizationRpcConfigs.id, row.id));
  return { ok: true, config: toView(row) };
}

/** Call every stored URL again and record the outcome. */
export async function retestOrgRpcConfig(input: {
  organizationId: string;
  configId: string;
}): Promise<OrgRpcResult<{ config: OrgRpcConfigView; allOk: boolean }>> {
  const row = await findRow(input.organizationId, input.configId);
  if (!row) {
    return failure(OrgRpcErrorCode.NOT_FOUND, "RPC config not found.");
  }
  const record = await loadEnabledChain(row.chainId);
  if (!record) {
    return failure(
      OrgRpcErrorCode.CHAIN_UNAVAILABLE,
      `Chain ${row.chainId} is not supported.`
    );
  }
  const urls = readUrls(row);
  if (!urls) {
    return failure(
      OrgRpcErrorCode.INVALID_INPUT,
      "This config's URLs can no longer be read. Edit it and paste them again."
    );
  }
  const checked = await verifyRpcConfigUrls(urls, record.chain);
  const [updated] = await db
    .update(organizationRpcConfigs)
    .set({ verification: checked.verification, updatedAt: new Date() })
    .where(eq(organizationRpcConfigs.id, row.id))
    .returning();
  return { ok: true, config: toView(updated), allOk: checked.ok };
}

// Policy --------------------------------------------------------------------

/** One chain's policy, and what turning own RPC only on would leave out. */
export type OrgRpcChainPolicyView = {
  chainId: number;
  ownRpcOnly: boolean;
  /** Nodes on this chain that would have no route under own RPC only. */
  gaps: CoverageGap[];
};

export type OrgRpcPolicyView = { chains: OrgRpcChainPolicyView[] };

/** Gaps on one chain if it were served only by the organization's configs. */
function gapsIfOwnRpcOnly(
  organizationId: string,
  chainId: number,
  usages: readonly NodeChainUsage[],
  configs: readonly OrgRpcConfig[],
  platform: ReadonlyMap<number, PlatformChainRecord>
): CoverageGap[] {
  return findCoverageGaps({
    organizationId,
    usages: usages.filter((usage) => usage.chainId === chainId),
    platform,
    ownRpcOnlyChains: new Set([chainId]),
    configs,
  });
}

/**
 * The policy of every chain the organization has a config on or enforces,
 * with the nodes that would block turning own RPC only on for it.
 */
export async function getOrgRpcPolicyView(
  organizationId: string
): Promise<OrgRpcPolicyView> {
  const [ownRpcOnlyChains, configs, usages] = await Promise.all([
    loadOwnRpcOnlyChains(organizationId),
    loadOrgRpcConfigs(organizationId),
    loadOrgUsages(organizationId),
  ]);
  const platform = await loadPlatformRecords(usages);
  const chainIds = new Set([
    ...ownRpcOnlyChains,
    ...configs.map((config) => config.chainId),
  ]);
  return {
    chains: [...chainIds]
      .sort((a, b) => a - b)
      .map((chainId) => ({
        chainId,
        ownRpcOnly: ownRpcOnlyChains.has(chainId),
        gaps: gapsIfOwnRpcOnly(
          organizationId,
          chainId,
          usages,
          configs,
          platform
        ),
      })),
  };
}

/**
 * Turn own RPC only on or off for one chain. Turning it on is refused while
 * any workflow node on that chain would be left without one of the
 * organization's endpoints.
 */
export async function setOrgRpcPolicy(input: {
  organizationId: string;
  userId: string;
  chainId: number;
  ownRpcOnly: boolean;
}): Promise<
  OrgRpcResult<{ policy: { chainId: number; ownRpcOnly: boolean } }>
> {
  if (input.ownRpcOnly) {
    if (!(await loadEnabledChain(input.chainId))) {
      return failure(
        OrgRpcErrorCode.CHAIN_UNAVAILABLE,
        `Chain ${input.chainId} is not supported.`
      );
    }
    const [usages, configs] = await Promise.all([
      loadOrgUsages(input.organizationId),
      loadOrgRpcConfigs(input.organizationId),
    ]);
    const platform = await loadPlatformRecords(usages);
    const gaps = gapsIfOwnRpcOnly(
      input.organizationId,
      input.chainId,
      usages,
      configs,
      platform
    );
    if (gaps.length > 0) {
      return failure(
        OrgRpcErrorCode.COVERAGE_GAPS,
        "Add an RPC config for this chain that covers these workflows first.",
        { gaps }
      );
    }
  }
  const now = new Date();
  await db
    .insert(organizationRpcChainPolicy)
    .values({
      organizationId: input.organizationId,
      chainId: input.chainId,
      ownRpcOnly: input.ownRpcOnly,
      changedBy: input.userId,
      changedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        organizationRpcChainPolicy.organizationId,
        organizationRpcChainPolicy.chainId,
      ],
      set: {
        ownRpcOnly: input.ownRpcOnly,
        changedBy: input.userId,
        changedAt: now,
      },
    });
  return {
    ok: true,
    policy: { chainId: input.chainId, ownRpcOnly: input.ownRpcOnly },
  };
}
