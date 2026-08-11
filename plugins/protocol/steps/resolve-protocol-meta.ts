import { getProtocol } from "@/lib/protocol-registry";

export type ProtocolMeta = {
  protocolSlug: string;
  contractKey: string;
  functionName: string;
  actionType: "read" | "write";
};

/**
 * Derive protocol metadata from _actionType by looking up the protocol registry.
 */
function deriveFromActionType(actionType: string): ProtocolMeta | undefined {
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

  return {
    protocolSlug,
    contractKey: action.contract,
    functionName: action.function,
    actionType: action.type,
  };
}

/**
 * Resolve protocol metadata from _protocolMeta JSON string or _actionType fallback.
 *
 * _actionType is always authoritative because it tracks the currently selected
 * action in the workflow builder. _protocolMeta is a cached snapshot that can
 * become stale when the user switches actions on an existing node.
 *
 * Resolution order:
 *   1. Derive from _actionType (always reflects the current action selection)
 *   2. Fall back to _protocolMeta JSON (for nodes created before this fix)
 */
export function resolveProtocolMeta(input: {
  _protocolMeta?: string;
  _actionType?: string;
}): ProtocolMeta | undefined {
  // Prefer _actionType -- it always reflects the current action selection
  if (typeof input._actionType === "string") {
    const derived = deriveFromActionType(input._actionType);
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
