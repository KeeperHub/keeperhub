import { OrgRpcErrorCode } from "@/lib/rpc/engine/org/codes";
import type { CoverageGap } from "@/lib/rpc/engine/org/coverage";
import type {
  OrgRpcConfigView,
  OrgRpcPolicyView,
} from "@/lib/rpc/engine/org/service";
import {
  RPC_CONFIG_SLOTS_BY_CHAIN_TYPE,
  RPC_CONFIG_URL_SLOTS,
  RpcConfigUrlSlot,
  SLOT_TRANSPORT,
} from "@/lib/rpc/engine/org/url-slots";
import { RpcChainType, RpcTransport } from "@/lib/rpc/engine/types";
import {
  type CreateRpcConfigBody,
  OrgRpcApiError,
  type RpcChainOption,
  type UpdateRpcConfigBody,
} from "@/lib/rpc/org-rpc-client";

/** The per-chain switch that stops KeeperHub's endpoints from serving it. */
export const YOUR_ENDPOINTS_ONLY = "Your endpoints only";

export const CHAIN_TYPE_LABEL: Readonly<Record<RpcChainType, string>> = {
  [RpcChainType.EVM]: "EVM",
  [RpcChainType.SOLANA]: "Solana",
};

/** A badge fill that stays visible on plain, hovered and selected rows. */
export const SUBTLE_BADGE_CLASS = "border-transparent bg-foreground/10";

export const SLOT_LABEL: Readonly<Record<RpcConfigUrlSlot, string>> = {
  [RpcConfigUrlSlot.HTTP_PRIMARY]: "HTTPS primary",
  [RpcConfigUrlSlot.HTTP_FALLBACK]: "HTTPS fallback",
  [RpcConfigUrlSlot.WSS_PRIMARY]: "WSS primary",
  [RpcConfigUrlSlot.WSS_FALLBACK]: "WSS fallback",
  [RpcConfigUrlSlot.PRIVATE_TX]: "Private transaction URL",
};

/** Short slot names for the compact endpoint line. */
export const SLOT_SHORT_LABEL: Readonly<Record<RpcConfigUrlSlot, string>> = {
  [RpcConfigUrlSlot.HTTP_PRIMARY]: "HTTPS",
  [RpcConfigUrlSlot.HTTP_FALLBACK]: "HTTPS fallback",
  [RpcConfigUrlSlot.WSS_PRIMARY]: "WSS",
  [RpcConfigUrlSlot.WSS_FALLBACK]: "WSS fallback",
  [RpcConfigUrlSlot.PRIVATE_TX]: "Private tx",
};

/** The one slot every config must fill. */
export const REQUIRED_SLOT = RpcConfigUrlSlot.HTTP_PRIMARY;

/** The URL inputs a config on this kind of chain takes, in display order. */
export function slotsForChainType(
  chainType: RpcChainType
): readonly RpcConfigUrlSlot[] {
  return RPC_CONFIG_SLOTS_BY_CHAIN_TYPE[chainType];
}

export function slotPlaceholder(slot: RpcConfigUrlSlot): string {
  return SLOT_TRANSPORT[slot] === RpcTransport.WSS ? "wss://" : "https://";
}

/** Slots a saved config has a URL in, in display order. */
export function filledSlots(config: OrgRpcConfigView): RpcConfigUrlSlot[] {
  return RPC_CONFIG_URL_SLOTS.filter((slot) => config.slots.includes(slot));
}

export type ChainOptionGroups = {
  mainnets: RpcChainOption[];
  testnets: RpcChainOption[];
};

/** Chains split into mainnets and testnets, each by name. */
export function groupChainOptions(
  chains: readonly RpcChainOption[]
): ChainOptionGroups {
  const sorted = [...chains].sort(
    (a, b) => a.name.localeCompare(b.name) || a.chainId - b.chainId
  );
  return {
    mainnets: sorted.filter((chain) => !chain.isTestnet),
    testnets: sorted.filter((chain) => chain.isTestnet),
  };
}

export type RpcChainGroup = {
  chainId: number;
  name: string;
  /** Null when the chain is no longer offered (disabled since). */
  chainType: RpcChainType | null;
  /** Null when the chain is no longer offered. */
  isTestnet: boolean | null;
  configs: OrgRpcConfigView[];
  /** Whether only the organization's own endpoints serve this chain. */
  ownRpcOnly: boolean;
  /** Nodes on this chain that block or break own RPC only. */
  gaps: CoverageGap[];
};

/**
 * Configs under their chain, chains by name, and inside a chain the default
 * first and the rest by name. A chain set to own RPC only keeps its group
 * with no configs left, so it can still be turned off.
 */
export function groupConfigsByChain(
  configs: readonly OrgRpcConfigView[],
  chains: readonly RpcChainOption[],
  policy: OrgRpcPolicyView
): RpcChainGroup[] {
  const chainById = new Map(chains.map((chain) => [chain.chainId, chain]));
  const policyByChain = new Map(
    policy.chains.map((entry) => [entry.chainId, entry])
  );
  const groups = new Map<number, RpcChainGroup>();
  const groupFor = (chainId: number): RpcChainGroup => {
    const existing = groups.get(chainId);
    if (existing) {
      return existing;
    }
    const chain = chainById.get(chainId);
    const chainPolicy = policyByChain.get(chainId);
    const group: RpcChainGroup = {
      chainId,
      name: chain?.name ?? `Chain ${chainId}`,
      chainType: chain?.chainType ?? null,
      isTestnet: chain?.isTestnet ?? null,
      configs: [],
      ownRpcOnly: chainPolicy?.ownRpcOnly ?? false,
      gaps: chainPolicy?.gaps ?? [],
    };
    groups.set(chainId, group);
    return group;
  };
  for (const config of configs) {
    groupFor(config.chainId).configs.push(config);
  }
  for (const entry of policy.chains) {
    if (entry.ownRpcOnly) {
      groupFor(entry.chainId);
    }
  }
  const sorted = [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.chainId - b.chainId
  );
  for (const group of sorted) {
    group.configs.sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name)
    );
  }
  return sorted;
}

/** How a chain's endpoints are doing, for its summary row. */
export type ChainGroupHealth = {
  /** URLs whose last check failed, across the chain's configs. */
  failedChecks: number;
  /** Workflow nodes on the chain that block or break own RPC only. */
  gaps: number;
};

export function chainGroupHealth(group: RpcChainGroup): ChainGroupHealth {
  let failedChecks = 0;
  for (const config of group.configs) {
    for (const check of Object.values(config.verification)) {
      if (check && !check.ok) {
        failedChecks += 1;
      }
    }
  }
  return { failedChecks, gaps: group.gaps.length };
}

export const RpcChainFilter = {
  ALL: "all",
  MAINNETS: "mainnets",
  TESTNETS: "testnets",
  OWN_RPC_ONLY: "own-rpc-only",
  NEEDS_ATTENTION: "needs-attention",
} as const;
export type RpcChainFilter =
  (typeof RpcChainFilter)[keyof typeof RpcChainFilter];

export const RPC_CHAIN_FILTER_LABEL: Readonly<Record<RpcChainFilter, string>> =
  {
    [RpcChainFilter.ALL]: "All chains",
    [RpcChainFilter.MAINNETS]: "Mainnets",
    [RpcChainFilter.TESTNETS]: "Testnets",
    [RpcChainFilter.OWN_RPC_ONLY]: YOUR_ENDPOINTS_ONLY,
    [RpcChainFilter.NEEDS_ATTENTION]: "Needs attention",
  };

const FILTER_MATCHES: Readonly<
  Record<RpcChainFilter, (group: RpcChainGroup) => boolean>
> = {
  [RpcChainFilter.ALL]: () => true,
  [RpcChainFilter.MAINNETS]: (group) => group.isTestnet === false,
  [RpcChainFilter.TESTNETS]: (group) => group.isTestnet === true,
  [RpcChainFilter.OWN_RPC_ONLY]: (group) => group.ownRpcOnly,
  [RpcChainFilter.NEEDS_ATTENTION]: (group) => {
    const health = chainGroupHealth(group);
    return health.failedChecks > 0 || health.gaps > 0;
  },
};

function matchesQuery(group: RpcChainGroup, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const haystack = [
    group.name,
    String(group.chainId),
    ...group.configs.map((config) => config.name),
  ];
  return haystack.some((text) => text.toLowerCase().includes(query));
}

/** Groups whose chain or endpoint names, or chain ID, match, under the filter. */
export function filterChainGroups(
  groups: readonly RpcChainGroup[],
  query: string,
  filter: RpcChainFilter
): RpcChainGroup[] {
  const needle = query.trim().toLowerCase();
  return groups.filter(
    (group) => FILTER_MATCHES[filter](group) && matchesQuery(group, needle)
  );
}

export type GapsByWorkflow = {
  workflowId: string;
  workflowName: string;
  gaps: CoverageGap[];
};

/** Gaps under the workflow they belong to, in the order first seen. */
export function groupGapsByWorkflow(
  gaps: readonly CoverageGap[]
): GapsByWorkflow[] {
  const byWorkflow = new Map<string, GapsByWorkflow>();
  for (const gap of gaps) {
    let entry = byWorkflow.get(gap.workflowId);
    if (!entry) {
      entry = {
        workflowId: gap.workflowId,
        workflowName: gap.workflowName,
        gaps: [],
      };
      byWorkflow.set(gap.workflowId, entry);
    }
    entry.gaps.push(gap);
  }
  return [...byWorkflow.values()];
}

export function workflowEditorHref(workflowId: string): string {
  return `/workflows/${encodeURIComponent(workflowId)}`;
}

/** URL inputs as typed, by slot. Empty means nothing was entered. */
export type UrlDraft = Partial<Record<RpcConfigUrlSlot, string>>;

export type CreateDraft = {
  chain: RpcChainOption | null;
  name: string;
  urls: UrlDraft;
  isDefault: boolean;
};

/** The request body for a new config, or null while it is incomplete. */
export function buildCreateBody(
  draft: CreateDraft
): CreateRpcConfigBody | null {
  const name = draft.name.trim();
  const primary = draft.urls[REQUIRED_SLOT]?.trim() ?? "";
  if (!(draft.chain && name && primary)) {
    return null;
  }
  const urls: CreateRpcConfigBody["urls"] = { [REQUIRED_SLOT]: primary };
  for (const slot of slotsForChainType(draft.chain.chainType)) {
    const value = draft.urls[slot]?.trim();
    if (slot !== REQUIRED_SLOT && value) {
      urls[slot] = value;
    }
  }
  return {
    chainId: draft.chain.chainId,
    name,
    urls,
    // Left out when off, so the first config on a chain still becomes its
    // default on the server.
    ...(draft.isDefault ? { isDefault: true } : {}),
  };
}

export type EditDraft = {
  name: string;
  enabled: boolean;
  isDefault: boolean;
  /** A new URL per slot. Empty keeps the saved one. */
  urls: UrlDraft;
  /** Saved URLs to remove. Never holds the required slot. */
  cleared: ReadonlySet<RpcConfigUrlSlot>;
};

export function editDraftFor(config: OrgRpcConfigView): EditDraft {
  return {
    name: config.name,
    enabled: config.enabled,
    isDefault: config.isDefault,
    urls: {},
    cleared: new Set(),
  };
}

/**
 * Only what changed: a typed URL replaces its slot, a cleared one is sent as
 * null, and an untouched one is left out so the server keeps it.
 */
export function buildUpdateBody(
  config: OrgRpcConfigView,
  draft: EditDraft
): UpdateRpcConfigBody {
  const body: UpdateRpcConfigBody = {};
  const name = draft.name.trim();
  if (name && name !== config.name) {
    body.name = name;
  }
  if (draft.enabled !== config.enabled) {
    body.enabled = draft.enabled;
  }
  if (draft.isDefault !== config.isDefault) {
    body.isDefault = draft.isDefault;
  }
  const urls: NonNullable<UpdateRpcConfigBody["urls"]> = {};
  for (const slot of RPC_CONFIG_URL_SLOTS) {
    const value = draft.urls[slot]?.trim();
    if (value) {
      urls[slot] = value;
    } else if (
      slot !== REQUIRED_SLOT &&
      draft.cleared.has(slot) &&
      config.slots.includes(slot)
    ) {
      urls[slot] = null;
    }
  }
  if (Object.keys(urls).length > 0) {
    body.urls = urls;
  }
  return body;
}

export function hasChanges(body: UpdateRpcConfigBody): boolean {
  return Object.keys(body).length > 0;
}

export type RpcFormErrors = {
  name?: string;
  slots: Partial<Record<RpcConfigUrlSlot, string>>;
  /** Shown above the form's buttons when no field owns the problem. */
  form?: string;
  gaps: CoverageGap[];
};

export const NO_FORM_ERRORS: RpcFormErrors = { slots: {}, gaps: [] };

const FAILED_CHECK_FALLBACK = "This URL did not pass the check.";

/** Where a refused save puts its message: on a field, or on the form. */
export function formErrorsFrom(
  error: unknown,
  fallback: string
): RpcFormErrors {
  if (!(error instanceof OrgRpcApiError)) {
    return { ...NO_FORM_ERRORS, form: fallback };
  }
  if (error.code === OrgRpcErrorCode.NAME_TAKEN) {
    return { ...NO_FORM_ERRORS, name: error.message };
  }
  if (error.code === OrgRpcErrorCode.COVERAGE_GAPS) {
    return { slots: {}, form: error.message, gaps: error.gaps };
  }
  if (error.code === OrgRpcErrorCode.VERIFICATION_FAILED) {
    const slots: RpcFormErrors["slots"] = {};
    for (const slot of RPC_CONFIG_URL_SLOTS) {
      const check = error.verification?.[slot];
      if (check && !check.ok) {
        slots[slot] = check.error ?? FAILED_CHECK_FALLBACK;
      }
    }
    return Object.keys(slots).length > 0
      ? { slots, gaps: [] }
      : { ...NO_FORM_ERRORS, form: error.message };
  }
  return { ...NO_FORM_ERRORS, form: error.message };
}

/** True when the refusal carries the nodes it would have left uncovered. */
export function isCoverageRefusal(error: unknown): error is OrgRpcApiError {
  return (
    error instanceof OrgRpcApiError &&
    error.code === OrgRpcErrorCode.COVERAGE_GAPS &&
    error.gaps.length > 0
  );
}
