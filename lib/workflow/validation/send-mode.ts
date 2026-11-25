import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import {
  chainHasPrivateRelay,
  hasLegacyFlagOnly,
  isLooseLegacyFlag,
  isSendMode,
  LEGACY_PRIVATE_MEMPOOL_KEY,
  legacyFlagTypeIssue,
  resolveSendMode,
  SEND_MODE,
  SEND_MODE_KEY,
  type SendMode,
  type SendModeChain,
  sendModeConflict,
  sendModeOption,
  unknownSendModeIssue,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";
import { sendModeNetworkField } from "@/lib/workflow/editor/send-mode-editor";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";
import type {
  ActionConfigValidationIssue,
  ActionConfigValidationResult,
  WorkflowNodeForValidation,
} from "@/lib/workflow/validation/action-config";

type Node = WorkflowNodeForValidation;
type Config = Record<string, unknown>;

export type SendModeSaveOptions = {
  // The workflow's nodes as stored, when an existing workflow is saved.
  savedNodes?: readonly Node[];
  // An import keeps old "(Flashbots)" steps as they were exported.
  keepLegacy?: boolean;
};

function chainIdOf(network: unknown): number | undefined {
  if (typeof network !== "string" && typeof network !== "number") {
    return;
  }
  if (typeof network === "string" && valueContainsTemplate(network)) {
    return;
  }
  try {
    return getChainIdFromNetwork(network);
  } catch {
    // An unknown network is reported by the network field's own check.
    return;
  }
}

/** Saved configs by node id, for ids that appear once in the incoming list. */
function savedById(
  nodes: readonly Node[],
  savedNodes: readonly Node[] = []
): Map<string, Config> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (typeof node.id === "string") {
      counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    }
  }
  const saved = new Map<string, Config>();
  for (const node of savedNodes) {
    const config = node.data?.config;
    if (typeof node.id === "string" && config && counts.get(node.id) === 1) {
      saved.set(node.id, config);
    }
  }
  return saved;
}

/** Same action, network and Send as keys as stored: let through as saved. */
function unchangedFromSaved(
  config: Config,
  before: Config | undefined,
  networkField: string
): boolean {
  return (
    before !== undefined &&
    before.actionType === config.actionType &&
    Object.is(before[networkField], config[networkField]) &&
    Object.is(before[SEND_MODE_KEY], config[SEND_MODE_KEY]) &&
    Object.is(
      before[LEGACY_PRIVATE_MEMPOOL_KEY],
      config[LEGACY_PRIVATE_MEMPOOL_KEY]
    )
  );
}

/**
 * On an update where a caller changed only one of `sendMode` / `usePrivateMempool`,
 * that key wins and both are written back in agreement. Mutates `nodes`.
 */
export function reconcileSendModeKeys(
  nodes: readonly Node[],
  savedNodes: readonly Node[]
): void {
  const saved = savedById(nodes, savedNodes);
  for (const node of nodes) {
    const config = node.data?.config;
    const before = typeof node.id === "string" ? saved.get(node.id) : undefined;
    if (
      !(config && before && sendModeNetworkField(config)) ||
      before.actionType !== config.actionType ||
      !sendModeConflict(config)
    ) {
      continue;
    }
    const mode = config[SEND_MODE_KEY];
    const flag = config[LEGACY_PRIVATE_MEMPOOL_KEY];
    const modeChanged = !Object.is(mode, before[SEND_MODE_KEY]);
    const flagChanged = !Object.is(flag, before[LEGACY_PRIVATE_MEMPOOL_KEY]);
    if (flagChanged && !modeChanged && typeof flag === "boolean") {
      config[SEND_MODE_KEY] = flag
        ? SEND_MODE.PRIVATE_RELAY
        : SEND_MODE.TRANSACTION;
    } else if (modeChanged && !flagChanged && isSendMode(mode)) {
      config[LEGACY_PRIVATE_MEMPOOL_KEY] = mode === SEND_MODE.PRIVATE_RELAY;
    }
  }
}

type Candidate = {
  index: number;
  node: Node;
  chainId: number | undefined;
  mode: SendMode;
  // A loose legacy flag sends as Normal on a chain without the relay.
  loose: boolean;
  // Why the step cannot send with `mode`, unless kept as stored.
  unsupported?: string;
};

function issueFor(
  index: number,
  node: Node,
  received: unknown,
  message: string,
  field: string = SEND_MODE_KEY
): ActionConfigValidationIssue {
  const nodeId =
    typeof node.id === "string" && node.id !== "" ? node.id : undefined;
  const label = node.data?.label;
  return {
    code: "INVALID_FIELD_VALUE",
    path: `nodes[${index}].data.config.${field}`,
    actionType: String(node.data?.config?.actionType ?? ""),
    field,
    nodeId,
    nodeLabel: typeof label === "string" && label !== "" ? label : nodeId,
    received,
    message,
  };
}

/** Same action and Send as as stored: a step it cannot send with stays saveable. */
function sameRoute(config: Config, before: Config | undefined): boolean {
  return (
    before !== undefined &&
    before.actionType === config.actionType &&
    resolveSendMode(before) === resolveSendMode(config)
  );
}

/** The checks that need no database, for one node; a candidate for the rest. */
function nodeIssues(
  index: number,
  node: Node,
  config: Config,
  networkField: string,
  kept: { legacy: boolean; flag: boolean; route: boolean }
): { issue?: ActionConfigValidationIssue; candidate?: Candidate } {
  const unknown = unknownSendModeIssue(config[SEND_MODE_KEY]);
  if (unknown) {
    return { issue: issueFor(index, node, config[SEND_MODE_KEY], unknown) };
  }
  const conflict = sendModeConflict(config);
  if (conflict) {
    return { issue: issueFor(index, node, config[SEND_MODE_KEY], conflict) };
  }
  const flagIssue =
    kept.legacy || kept.flag
      ? undefined
      : legacyFlagTypeIssue(config[LEGACY_PRIVATE_MEMPOOL_KEY]);
  if (flagIssue) {
    return {
      issue: issueFor(
        index,
        node,
        config[LEGACY_PRIVATE_MEMPOOL_KEY],
        flagIssue,
        LEGACY_PRIVATE_MEMPOOL_KEY
      ),
    };
  }
  const mode = resolveSendMode(config);
  if (mode === SEND_MODE.TRANSACTION) {
    return {};
  }
  const reason =
    kept.legacy || kept.route
      ? undefined
      : unsupportedSendMode(config.actionType, mode);
  return {
    candidate: {
      index,
      node,
      // A network set by a template is checked when the step runs.
      chainId: chainIdOf(config[networkField]),
      mode,
      loose: isLooseLegacyFlag(config),
      unsupported: reason
        ? `Send as "${mode}" is not available on this step. ${reason}`
        : undefined,
    },
  };
}

/** One issue at most: the step cannot send so, or the chain cannot. */
function candidateIssue(
  candidate: Candidate,
  row: SendModeChain | undefined
): ActionConfigValidationIssue | undefined {
  const { index, node, chainId, mode, loose, unsupported } = candidate;
  const available =
    chainId === undefined || sendModeOption(mode).availableOn(row);
  if (loose && !available) {
    return;
  }
  if (unsupported) {
    return issueFor(index, node, mode, unsupported);
  }
  if (available) {
    return;
  }
  return issueFor(
    index,
    node,
    mode,
    `Send as "${mode}" is not available on chain ${chainId}. Set sendMode to "${SEND_MODE.TRANSACTION}", or use a network that offers it.`
  );
}

/**
 * Save-time Send as checks (known value, keys agree, step and chain offer it).
 * Nodes unchanged from `savedNodes`, and stored old flags on import, pass.
 */
export async function validateSendModeForSave(
  nodes: readonly Node[],
  options: SendModeSaveOptions = {}
): Promise<ActionConfigValidationResult> {
  const saved = savedById(nodes, options.savedNodes);
  const issues: ActionConfigValidationIssue[] = [];
  const candidates: Candidate[] = [];
  for (const [index, node] of nodes.entries()) {
    const config = node.data?.config;
    const networkField = config ? sendModeNetworkField(config) : undefined;
    if (!(config && networkField)) {
      continue;
    }
    const before = typeof node.id === "string" ? saved.get(node.id) : undefined;
    if (unchangedFromSaved(config, before, networkField)) {
      continue;
    }
    const { issue, candidate } = nodeIssues(index, node, config, networkField, {
      legacy: options.keepLegacy === true && hasLegacyFlagOnly(config),
      flag:
        before !== undefined &&
        Object.is(
          before[LEGACY_PRIVATE_MEMPOOL_KEY],
          config[LEGACY_PRIVATE_MEMPOOL_KEY]
        ),
      route: sameRoute(config, before),
    });
    if (issue) {
      issues.push(issue);
    }
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const ids = [
    ...new Set(
      candidates
        .map((candidate) => candidate.chainId)
        .filter((id): id is number => id !== undefined)
    ),
  ];
  const rows =
    ids.length > 0
      ? await db
          .select({
            chainId: chains.chainId,
            usePrivateMempoolRpc: chains.usePrivateMempoolRpc,
            defaultPrivateRpcUrl: chains.defaultPrivateRpcUrl,
          })
          .from(chains)
          .where(inArray(chains.chainId, ids))
      : [];
  const byId = new Map(
    rows.map((row) => [
      row.chainId,
      { usePrivateMempoolRpc: chainHasPrivateRelay(row) },
    ])
  );
  for (const candidate of candidates) {
    const issue = candidateIssue(
      candidate,
      candidate.chainId === undefined ? undefined : byId.get(candidate.chainId)
    );
    if (issue) {
      issues.push(issue);
    }
  }
  return { valid: issues.length === 0, issues };
}
