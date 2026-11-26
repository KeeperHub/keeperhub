import type { OrgRpcConfigView } from "@/lib/rpc/engine/org/service";
import { RpcConfigUrlSlot } from "@/lib/rpc/engine/org/url-slots";
import { parseRpcSelection } from "@/lib/rpc/engine/scope";
import { RpcSelectionMode } from "@/lib/rpc/engine/types";

/** What the editor needs to know about one of the organization's configs. */
export type RpcConfigSummary = Pick<
  OrgRpcConfigView,
  "id" | "name" | "chainId" | "isDefault" | "enabled" | "slots"
>;

export type OrgRpcEditorState = {
  configs: readonly RpcConfigSummary[];
  /** Chains served only by the organization's own endpoints. */
  ownRpcOnlyChains: readonly number[];
};

export function isOwnRpcOnly(
  state: OrgRpcEditorState,
  chainId: number | null
): boolean {
  return chainId !== null && state.ownRpcOnlyChains.includes(chainId);
}

export const PLATFORM_LABEL = "KeeperHub";

const MESSAGES = {
  notFound: "This RPC config no longer exists. Pick another one.",
  disabled: "This RPC config is disabled. Pick another one.",
  otherChain: "This RPC config is for another network. Pick another one.",
  notCovered:
    "No RPC config covers this network. Add one in your organization settings.",
  platformForbidden:
    "This network is set to use only your organization's endpoints.",
  noPrivateUrl: "Add a private transaction URL to this network's RPC config.",
} as const;

/** Where a node's RPC selection leads on one network. */
export type NodeRpcResolution =
  | { kind: "platform" }
  | { kind: "config"; config: RpcConfigSummary }
  | { kind: "invalid"; message: string };

/**
 * The config a stored selection resolves to on `chainId`, following the same
 * precedence as the engine's resolver: a pinned config, then the network's
 * default, then KeeperHub unless the organization uses its own RPC only on
 * that network.
 */
export function resolveNodeRpc(
  value: unknown,
  chainId: number,
  state: OrgRpcEditorState
): NodeRpcResolution {
  const selection = parseRpcSelection(value);
  const ownOnly = isOwnRpcOnly(state, chainId);
  if (selection.mode === RpcSelectionMode.PLATFORM) {
    return ownOnly
      ? { kind: "invalid", message: MESSAGES.platformForbidden }
      : { kind: "platform" };
  }
  if (selection.mode === RpcSelectionMode.CONFIG) {
    const config = state.configs.find((c) => c.id === selection.configId);
    if (!config) {
      return { kind: "invalid", message: MESSAGES.notFound };
    }
    if (config.chainId !== chainId) {
      return { kind: "invalid", message: MESSAGES.otherChain };
    }
    if (!config.enabled) {
      return { kind: "invalid", message: MESSAGES.disabled };
    }
    return { kind: "config", config };
  }
  const fallback = state.configs.find(
    (c) => c.chainId === chainId && c.isDefault && c.enabled
  );
  if (fallback) {
    return { kind: "config", config: fallback };
  }
  return ownOnly
    ? { kind: "invalid", message: MESSAGES.notCovered }
    : { kind: "platform" };
}

export type RpcConfigOption = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export type RpcConfigOptions = {
  /** The value the select shows; blank stored values read as auto. */
  value: string;
  options: RpcConfigOption[];
  /** Why the stored selection gives the node no route, when it does not. */
  problem: string | null;
};

export function parseChainId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const text = String(value).trim();
  if (text.length === 0) {
    return null;
  }
  const chainId = Number(text);
  return Number.isInteger(chainId) ? chainId : null;
}

function autoHint(resolution: NodeRpcResolution | null): string {
  if (!resolution) {
    return "Uses the organization default for the selected network";
  }
  if (resolution.kind === "config") {
    return `Uses ${resolution.config.name}`;
  }
  if (resolution.kind === "platform") {
    return `Uses ${PLATFORM_LABEL}`;
  }
  return "No RPC config for this network";
}

function pinnedProblem(
  configId: string,
  chainId: number | null,
  state: OrgRpcEditorState
): string | null {
  if (chainId !== null) {
    const resolution = resolveNodeRpc(configId, chainId, state);
    return resolution.kind === "invalid" ? resolution.message : null;
  }
  const config = state.configs.find((c) => c.id === configId);
  if (!config) {
    return MESSAGES.notFound;
  }
  return config.enabled ? null : MESSAGES.disabled;
}

/**
 * The choices the RPC selector offers on a node: Auto, KeeperHub, then the
 * organization's enabled configs for the node's network. A stored config that
 * can no longer serve the node is kept in the list, locked, with the reason.
 */
export function buildRpcConfigOptions(
  value: unknown,
  networkValue: unknown,
  state: OrgRpcEditorState
): RpcConfigOptions {
  const chainId = parseChainId(networkValue);
  const selection = parseRpcSelection(value);
  const autoResolution =
    chainId === null
      ? null
      : resolveNodeRpc(RpcSelectionMode.AUTO, chainId, state);
  const ownOnly = isOwnRpcOnly(state, chainId);

  const options: RpcConfigOption[] = [
    {
      value: RpcSelectionMode.AUTO,
      label: "Auto",
      hint: autoHint(autoResolution),
    },
    {
      value: RpcSelectionMode.PLATFORM,
      label: `${PLATFORM_LABEL} default`,
      disabled: ownOnly,
      hint: ownOnly ? MESSAGES.platformForbidden : undefined,
    },
  ];
  if (chainId !== null) {
    const forChain = state.configs
      .filter((c) => c.enabled && c.chainId === chainId)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const config of forChain) {
      options.push({
        value: config.id,
        label: config.name,
        hint: config.isDefault ? "Default for this network" : undefined,
      });
    }
  }

  if (selection.mode === RpcSelectionMode.AUTO) {
    return {
      value: RpcSelectionMode.AUTO,
      options,
      problem:
        autoResolution?.kind === "invalid" ? autoResolution.message : null,
    };
  }
  if (selection.mode === RpcSelectionMode.PLATFORM) {
    return {
      value: RpcSelectionMode.PLATFORM,
      options,
      problem: ownOnly ? MESSAGES.platformForbidden : null,
    };
  }

  const problem = pinnedProblem(selection.configId, chainId, state);
  if (!options.some((option) => option.value === selection.configId)) {
    const stored = state.configs.find((c) => c.id === selection.configId);
    options.push({
      value: selection.configId,
      label: stored?.name ?? "Unknown RPC config",
      disabled: true,
      hint: problem ?? undefined,
    });
  }
  return { value: selection.configId, options, problem };
}

export type PrivateMempoolVariant =
  | { offered: false }
  | { offered: true; label: string; disabledReason: string | null };

/**
 * Whether a chain's private mempool entry is offered on a node, and why it is
 * locked when it is. A config with a private transaction URL always offers
 * it; otherwise KeeperHub's relay does, unless the organization uses its own
 * RPC only on that chain.
 */
export function privateMempoolVariant(
  chain: { chainId: number; name: string; hasPlatformRelay: boolean },
  rpcValue: unknown,
  state: OrgRpcEditorState
): PrivateMempoolVariant {
  const resolution = resolveNodeRpc(rpcValue, chain.chainId, state);
  if (
    resolution.kind === "config" &&
    resolution.config.slots.includes(RpcConfigUrlSlot.PRIVATE_TX)
  ) {
    return {
      offered: true,
      label: `${chain.name} (Private, ${resolution.config.name})`,
      disabledReason: null,
    };
  }
  if (isOwnRpcOnly(state, chain.chainId)) {
    return chain.hasPlatformRelay || resolution.kind === "config"
      ? {
          offered: true,
          label: `${chain.name} (Private)`,
          disabledReason: MESSAGES.noPrivateUrl,
        }
      : { offered: false };
  }
  return chain.hasPlatformRelay
    ? {
        offered: true,
        label: `${chain.name} (Flashbots)`,
        disabledReason: null,
      }
    : { offered: false };
}
