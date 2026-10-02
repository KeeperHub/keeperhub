import { getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { resolveRenamedAction } from "@/lib/protocol-action-aliases";
import { getProtocol } from "@/lib/protocol-registry";

export type ProtocolMeta = {
  protocolSlug: string;
  contractKey: string;
  functionName: string;
  actionType: "read" | "write";
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
  if (resolved !== action) {
    // The only signal that an alias entry is still load-bearing. A counter
    // rather than a log line: this fires once per aliased node execution (a
    // minutely schedule is roughly 1.4k a day from one node), and the question
    // it has to answer - "has anything entered on this slug since we last
    // looked?" - is a time series, not a breadcrumb.
    getMetricsCollector().incrementCounter(MetricNames.PROTOCOL_ALIAS_REDIRECT, {
      action_type: actionType,
      chain_id: network ?? "",
    });
  }

  return {
    protocolSlug,
    contractKey: resolved.contract,
    functionName: resolved.function,
    actionType: resolved.type,
  };
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
