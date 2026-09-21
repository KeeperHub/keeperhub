import { getProtocol } from "@/lib/protocol-registry";

export type ProtocolMeta = {
  protocolSlug: string;
  contractKey: string;
  functionName: string;
  actionType: "read" | "write";
};

/**
 * Action slugs that moved to a new contract key on specific chains, keyed by
 * the old `<protocol>/<slug>` action type.
 *
 * The bridged wstETH and sUSDS tokens implement the ERC-20 surface only, so
 * the full-ABI `wsteth`/`sUsds` contract keys stopped carrying an L2 address
 * and every action bound to them stopped resolving there. The two ERC-20
 * reads that did work on each L2 survive under the read-only `wstethL2` /
 * `sUsdsL2` keys with `-l2` slugs: same address, same selector, same 18
 * decimals. Without an alias a workflow saved against an old slug fails its
 * next run with `contract "sUsds" is not deployed on network "8453"`, which
 * is a break in the identifier rather than in the capability.
 *
 * Scoped per chain deliberately. The old slugs still exist and still work on
 * the chains where the full ABI is implemented (mainnet for both, plus
 * Sepolia for wstETH), so the alias must not shadow them there.
 */
export const L2_RENAMED_ACTIONS: Record<
  string,
  { slug: string; chainIds: readonly string[] }
> = {
  "sky/vault-balance": {
    slug: "get-susds-balance-l2",
    chainIds: ["8453", "42161"],
  },
  "sky/vault-total-supply": {
    slug: "get-susds-total-supply-l2",
    chainIds: ["8453", "42161"],
  },
  "lido/get-wsteth-balance": {
    slug: "get-wsteth-balance-l2",
    chainIds: ["8453"],
  },
  "lido/get-wsteth-total-supply": {
    slug: "get-wsteth-total-supply-l2",
    chainIds: ["8453"],
  },
};

/**
 * Derive protocol metadata from _actionType by looking up the protocol registry.
 *
 * `network` is the numeric chain ID as a string, the same key
 * `resolveContractAddress` indexes `contract.addresses` by. It is optional:
 * callers that only need the action's identity (is this a write? does this
 * action exist?) have no chain in hand, and without one no alias applies.
 */
function deriveFromActionType(
  actionType: string,
  network?: string
): ProtocolMeta | undefined {
  const slashIdx = actionType.indexOf("/");
  if (slashIdx <= 0) {
    return undefined;
  }

  const protocolSlug = actionType.substring(0, slashIdx);
  const actionSlug = actionType.substring(slashIdx + 1);
  const protocol = getProtocol(protocolSlug);
  if (!protocol) {
    return undefined;
  }

  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    return undefined;
  }

  const resolved = resolveRenamedAction(protocol, actionType, action, network);

  return {
    protocolSlug,
    contractKey: resolved.contract,
    functionName: resolved.function,
    actionType: resolved.type,
  };
}

type RegisteredProtocol = NonNullable<ReturnType<typeof getProtocol>>;
type RegisteredAction = RegisteredProtocol["actions"][number];

/**
 * Redirect a renamed action to its `-l2` replacement, or return it unchanged.
 *
 * The redirect is conditional on the originally bound contract having no
 * address on this chain, so the alias only fires where the old slug would
 * have failed. If a full-ABI `wsteth`/`sUsds` is ever deployed on one of
 * these chains the old slug starts resolving on its own and the alias steps
 * aside without needing to be deleted.
 */
function resolveRenamedAction(
  protocol: RegisteredProtocol,
  actionType: string,
  action: RegisteredAction,
  network: string | undefined
): RegisteredAction {
  if (network === undefined) {
    return action;
  }
  const rename = L2_RENAMED_ACTIONS[actionType];
  if (!rename?.chainIds.includes(network)) {
    return action;
  }
  if (protocol.contracts[action.contract]?.addresses[network] !== undefined) {
    return action;
  }
  return protocol.actions.find((a) => a.slug === rename.slug) ?? action;
}

/**
 * Resolve protocol metadata from _protocolMeta JSON string or _actionType fallback.
 *
 * _actionType is always authoritative because it tracks the currently selected
 * action in the workflow builder. _protocolMeta is a cached snapshot that can
 * become stale when the user switches actions on an existing node.
 *
 * `network` (the numeric chain ID as a string) is used only to apply the
 * chain-scoped aliases in L2_RENAMED_ACTIONS. Callers that pass no network
 * get the pre-alias behaviour.
 *
 * Resolution order:
 *   1. Derive from _actionType (always reflects the current action selection)
 *   2. Fall back to _protocolMeta JSON (for nodes created before this fix)
 */
export function resolveProtocolMeta(input: {
  _protocolMeta?: string;
  _actionType?: string;
  network?: string;
}): ProtocolMeta | undefined {
  // Prefer _actionType -- it always reflects the current action selection
  if (typeof input._actionType === "string") {
    const derived = deriveFromActionType(input._actionType, input.network);
    if (derived) {
      return derived;
    }
  }

  // Fall back to _protocolMeta for legacy nodes or non-protocol action types
  if (typeof input._protocolMeta === "string" && input._protocolMeta !== "") {
    try {
      return JSON.parse(input._protocolMeta) as ProtocolMeta;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Whether an action type is handled by the direct protocol execution route.
 * Keep this derived from the same registry lookup used by that route so
 * discovery cannot advertise a capability that execution does not recognise.
 */
export function isDirectExecutionSupported(actionType: string): boolean {
  return resolveProtocolMeta({ _actionType: actionType }) !== undefined;
}
