import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { builderLabels } from "@/lib/rpc/rpc-config";
import { minBlockGapSeconds } from "@/lib/web3/beacon-slots";
import { bundleLoopRefusal } from "@/lib/web3/bundles/loop-rule";
import { isBundleSendEnabledForOrg } from "@/lib/web3/bundles/rollout";
import {
  BUNDLE_SETTING_KEYS,
  BUNDLE_SETTING_LABELS,
  isUnset,
  NOT_BEFORE_UNSUPPORTED_ERROR,
  quoted,
  readBundleSettings,
  shortened,
} from "@/lib/web3/bundles/settings";
import {
  BUNDLE_SAFE_REFUSAL,
  chainHasBuilders,
  chainHasPrivateRelay,
  hasLegacyFlagOnly,
  isLegacyPrivateRelayConfig,
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
  USE_NORMAL_HINT,
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
import { loopDepthsOf } from "@/lib/workflow/validation/loop-depth";

type Node = WorkflowNodeForValidation;
type Config = Record<string, unknown>;

export type SendModeSaveOptions = {
  // The workflow's nodes as stored, when an existing workflow is saved.
  savedNodes?: readonly Node[];
  // An import keeps old "(Flashbots)" steps as they were exported (no stored copy to compare).
  keepLegacy?: boolean;
  // The saving organization, for the bundle rollout; none counts as outside it.
  organizationId?: string;
  // The workflow's edges, to find bundle steps inside nested For Each loops.
  edges?: readonly unknown[];
  // A single step run outside a workflow (direct execution), which cannot bundle.
  direct?: boolean;
  // Check bundle steps saved before as new ones (validate_workflow, duplicate), except
  // builders: a stored step is refused only when none of its builders is listed, as at run time.
  recheckBundles?: boolean;
  // A copy (duplicate): reasons say why the step cannot run, without advice the copier cannot act on.
  copy?: boolean;
};

/** A chain row as the checks read it, with the name messages use. */
type ChainRow = SendModeChain & { name?: string };

function networkName(chainId: number, row: ChainRow | undefined): string {
  return row?.name ?? `chain ${chainId}`;
}

const SET_TO_BUNDLE = 'Send as: Bundle (sendMode "bundle")';

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

/** `usePrivateMempool` as a save stores it: a missing one is filled from a known `sendMode`. */
function storedLegacyFlag(config: Config): unknown {
  const flag = config[LEGACY_PRIVATE_MEMPOOL_KEY];
  const mode = config[SEND_MODE_KEY];
  return flag === undefined && isSendMode(mode)
    ? mode === SEND_MODE.PRIVATE_RELAY
    : flag;
}

/** A bundle step's own settings and connection, as stored, to compare. */
function bundleKeysOf(config: Config): string {
  return JSON.stringify([
    config[BUNDLE_SETTING_KEYS.blocks],
    config[BUNDLE_SETTING_KEYS.tipIncreasePercent],
    config[BUNDLE_SETTING_KEYS.builders],
    config[BUNDLE_SETTING_KEYS.notBefore],
    config[BUNDLE_SETTING_KEYS.sendAheadBlocks],
    config.web3Connection,
  ]);
}

/** Same action, network and Send as keys (and bundle settings) as stored, the server's own fill included: let through as saved. */
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
    Object.is(storedLegacyFlag(before), storedLegacyFlag(config)) &&
    sendAheadKeysOf(before) === sendAheadKeysOf(config) &&
    (resolveSendMode(config) !== SEND_MODE.BUNDLE ||
      bundleKeysOf(before) === bundleKeysOf(config))
  );
}

/** Not before and Send ahead, compared on every Send as: only a bundle may hold them. */
function sendAheadKeysOf(config: Config): string {
  return JSON.stringify([
    config[BUNDLE_SETTING_KEYS.notBefore],
    config[BUNDLE_SETTING_KEYS.sendAheadBlocks],
  ]);
}

/** Not before or Send ahead set on a step that does not send as a bundle, which would ignore them. */
function strayBundleTimeIssue(
  index: number,
  node: Node,
  config: Config
): ActionConfigValidationIssue | undefined {
  const key = [
    BUNDLE_SETTING_KEYS.notBefore,
    BUNDLE_SETTING_KEYS.sendAheadBlocks,
  ].find((field) => !isUnset(config[field]));
  if (key === undefined) {
    return;
  }
  const label =
    key === BUNDLE_SETTING_KEYS.notBefore
      ? BUNDLE_SETTING_LABELS.notBefore
      : BUNDLE_SETTING_LABELS.sendAheadBlocks;
  return issueFor(
    index,
    node,
    config[key],
    `${label} (${key}) only works with ${SET_TO_BUNDLE}. Clear it, or set Send as to Bundle.`,
    key
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

/**
 * Fills a missing `usePrivateMempool` beside a known `sendMode`, for older executors. Mutates `nodes`.
 * A sent key is kept: a stored conflict stays as stored, so a stale client cannot flip the mode.
 */
export function writeLegacySendModeKey(nodes: readonly Node[]): void {
  for (const node of nodes) {
    const config = node.data?.config;
    const mode = config?.[SEND_MODE_KEY];
    if (
      config &&
      isSendMode(mode) &&
      sendModeNetworkField(config) &&
      config[LEGACY_PRIVATE_MEMPOOL_KEY] === undefined
    ) {
      config[LEGACY_PRIVATE_MEMPOOL_KEY] = mode === SEND_MODE.PRIVATE_RELAY;
    }
  }
}

type Candidate = {
  index: number;
  node: Node;
  chainId: number | undefined;
  mode: SendMode;
  // The old flag alone sends publicly on a chain without the relay.
  legacy: boolean;
  // Why the step cannot send with `mode`, unless kept as stored.
  unsupported?: string;
  // Bundle only: the builder names picked, none meaning all.
  builders?: string[];
  // Bundle only: a stored step rechecked as is, held to the run-time builder rule.
  storedAsIs?: boolean;
  // Bundle only: checked for a copy (see SendModeSaveOptions.copy).
  copy?: boolean;
  // Bundle only: Not before is set, which needs a chain with fixed slots.
  notBefore?: boolean;
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
type BundleContext = {
  enabled: boolean;
  direct: boolean;
  copy: boolean;
};

/** A bundle step's checks that need no database; a candidate for the chain's builders. */
function bundleNodeIssues(
  index: number,
  node: Node,
  config: Config,
  networkField: string,
  kept: { route: boolean; storedAsIs: boolean },
  ctx: BundleContext
): { issue?: ActionConfigValidationIssue; candidate?: Candidate } {
  const mode = SEND_MODE.BUNDLE;
  const keptRoute = kept.route;
  const refuse = (message: string, field: string = SEND_MODE_KEY) => ({
    issue: issueFor(
      index,
      node,
      field === SEND_MODE_KEY ? mode : config[field],
      message,
      field
    ),
  });
  if (ctx.direct) {
    return refuse(
      `${SET_TO_BUNDLE} only runs in a Write Contract step of a workflow, not through direct execution. ${USE_NORMAL_HINT}`
    );
  }
  // A step saved as a bundle before keeps saving (a rollback of the rollout included).
  const unsupported = keptRoute
    ? undefined
    : unsupportedSendMode(config.actionType, mode);
  if (unsupported) {
    return refuse(unsupported);
  }
  if (!(keptRoute || ctx.enabled)) {
    return refuse(
      ctx.copy
        ? `${SET_TO_BUNDLE} cannot run in your organization: bundles are not turned on for it yet.`
        : `${SET_TO_BUNDLE} is not turned on for this organization yet. ${USE_NORMAL_HINT}`
    );
  }
  if (String(config.web3Connection ?? "").startsWith("safe:")) {
    return refuse(
      `web3Connection "safe:...": ${BUNDLE_SAFE_REFUSAL}`,
      "web3Connection"
    );
  }
  const read = readBundleSettings(config, "save");
  if (!read.ok) {
    return refuse(read.error, read.field);
  }
  return {
    candidate: {
      index,
      node,
      chainId: chainIdOf(config[networkField]),
      mode,
      legacy: false,
      builders: read.settings.builders,
      storedAsIs: kept.storedAsIs,
      copy: ctx.copy,
      notBefore: !isUnset(config[BUNDLE_SETTING_KEYS.notBefore]),
    },
  };
}

/** The chain's checks for a bundle step: builders listed, and every picked one among them. */
function bundleCandidateIssue(
  candidate: Candidate,
  row: ChainRow | undefined
): ActionConfigValidationIssue | undefined {
  const { index, node, chainId, mode, builders } = candidate;
  if (chainId === undefined) {
    return;
  }
  if (!chainHasBuilders(row)) {
    return issueFor(
      index,
      node,
      mode,
      candidate.copy
        ? `${SET_TO_BUNDLE} cannot run on ${networkName(chainId, row)}: it has no block builders that take bundles.`
        : `${SET_TO_BUNDLE} is not available on ${networkName(chainId, row)}: it has no block builders that take bundles. ${USE_NORMAL_HINT}`
    );
  }
  if (candidate.notBefore && minBlockGapSeconds(chainId) === undefined) {
    return issueFor(
      index,
      node,
      node.data?.config?.[BUNDLE_SETTING_KEYS.notBefore],
      `${NOT_BEFORE_UNSUPPORTED_ERROR} ${networkName(chainId, row)} has no fixed block slots, so KeeperHub cannot tell which blocks would be early. Clear ${BUNDLE_SETTING_LABELS.notBefore} (notBefore).`,
      BUNDLE_SETTING_KEYS.notBefore
    );
  }
  const listed = row?.bundleBuilders ?? [];
  const unknown = (builders ?? []).filter((name) => !listed.includes(name));
  // Runs send to the listed ones, so a stored step fails only when none is listed.
  const runs =
    candidate.storedAsIs === true && unknown.length < (builders ?? []).length;
  if (unknown.length === 0 || runs) {
    return;
  }
  // Echoed names are cut short, in the message and in `received`.
  const shown = unknown.map(quoted);
  const received = unknown.map(shortened);
  if (candidate.copy && candidate.storedAsIs) {
    return issueFor(
      index,
      node,
      received,
      `${SET_TO_BUNDLE} cannot run: ${networkName(chainId, row)} lists none of its builders (${shown.join(", ")}).`,
      BUNDLE_SETTING_KEYS.builders
    );
  }
  return issueFor(
    index,
    node,
    received,
    `${BUNDLE_SETTING_LABELS.builders} (bundleBuilders) names ${unknown.length === 1 ? "a builder" : "builders"} ${networkName(chainId, row)} does not list: ${shown.join(", ")}. Pick from: ${listed.join(", ")}, or leave it out to send to all of them.`,
    BUNDLE_SETTING_KEYS.builders
  );
}

function nodeIssues(
  index: number,
  node: Node,
  config: Config,
  networkField: string,
  kept: { legacy: boolean; flag: boolean; route: boolean; storedAsIs: boolean },
  ctx: BundleContext
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
  if (mode !== SEND_MODE.BUNDLE) {
    const stray = strayBundleTimeIssue(index, node, config);
    if (stray) {
      return { issue: stray };
    }
  }
  if (mode === SEND_MODE.TRANSACTION) {
    return {};
  }
  if (mode === SEND_MODE.BUNDLE) {
    return bundleNodeIssues(index, node, config, networkField, kept, ctx);
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
      legacy: isLegacyPrivateRelayConfig(config),
      unsupported: reason
        ? `Send as "${mode}" is not available on this step. ${reason}`
        : undefined,
    },
  };
}

/** One issue at most: the step cannot send so, or the chain cannot. */
function candidateIssue(
  candidate: Candidate,
  row: ChainRow | undefined
): ActionConfigValidationIssue | undefined {
  if (candidate.mode === SEND_MODE.BUNDLE) {
    return bundleCandidateIssue(candidate, row);
  }
  const { index, node, chainId, mode, legacy, unsupported } = candidate;
  const available =
    chainId === undefined || sendModeOption(mode).availableOn(row);
  if (legacy && !available) {
    return;
  }
  if (unsupported) {
    return issueFor(index, node, mode, unsupported);
  }
  if (available || chainId === undefined) {
    return;
  }
  return issueFor(
    index,
    node,
    mode,
    `Send as "${mode}" is not available on ${networkName(chainId, row)}. Set sendMode to "${SEND_MODE.TRANSACTION}", or use a network that offers it.`
  );
}

/**
 * Bundle steps inside a For Each nested in another, refused as at run time.
 * Checked on every bundle step, unchanged ones included: the rule is not new.
 */
async function nestedLoopIssues(
  nodes: readonly Node[],
  edges: readonly unknown[] | undefined
): Promise<ActionConfigValidationIssue[]> {
  const bundleNodes = [...nodes.entries()].filter(([, node]) => {
    const config = node.data?.config;
    return (
      config !== undefined &&
      sendModeNetworkField(config) !== undefined &&
      resolveSendMode(config) === SEND_MODE.BUNDLE
    );
  });
  if (bundleNodes.length === 0 || !edges || edges.length === 0) {
    return [];
  }
  const depths = await loopDepthsOf(
    nodes,
    edges.filter((edge): edge is Record<string, unknown> => isObject(edge))
  );
  const issues: ActionConfigValidationIssue[] = [];
  for (const [index, node] of bundleNodes) {
    const depth = typeof node.id === "string" ? (depths.get(node.id) ?? 0) : 0;
    const refusal = bundleLoopRefusal(depth);
    if (refusal) {
      issues.push(issueFor(index, node, SEND_MODE.BUNDLE, refusal));
    }
  }
  return issues;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  const ctx: BundleContext = {
    enabled:
      options.organizationId !== undefined &&
      isBundleSendEnabledForOrg(options.organizationId),
    direct: options.direct === true,
    copy: options.copy === true,
  };
  issues.push(...(await nestedLoopIssues(nodes, options.edges)));
  const refusedNodes = new Set(issues.map((issue) => issue.nodeId));
  for (const [index, node] of nodes.entries()) {
    const config = node.data?.config;
    const networkField = config ? sendModeNetworkField(config) : undefined;
    if (!(config && networkField)) {
      continue;
    }
    const before = typeof node.id === "string" ? saved.get(node.id) : undefined;
    const recheck =
      options.recheckBundles === true &&
      resolveSendMode(config) === SEND_MODE.BUNDLE;
    const unchanged = unchangedFromSaved(config, before, networkField);
    // validate_workflow also flags a stored Not before / Send ahead a non-bundle step ignores.
    if (options.recheckBundles === true && !ctx.copy && !recheck && unchanged) {
      const stray = strayBundleTimeIssue(index, node, config);
      if (stray) {
        issues.push(stray);
      }
      continue;
    }
    if (!recheck && unchanged) {
      continue;
    }
    if (typeof node.id === "string" && refusedNodes.has(node.id)) {
      continue;
    }
    const { issue, candidate } = nodeIssues(
      index,
      node,
      config,
      networkField,
      {
        legacy: options.keepLegacy === true && hasLegacyFlagOnly(config),
        flag:
          before !== undefined &&
          Object.is(
            before[LEGACY_PRIVATE_MEMPOOL_KEY],
            config[LEGACY_PRIVATE_MEMPOOL_KEY]
          ),
        route: !recheck && sameRoute(config, before),
        storedAsIs: recheck && unchanged,
      },
      ctx
    );
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
            name: chains.name,
            usePrivateMempoolRpc: chains.usePrivateMempoolRpc,
            defaultPrivateRpcUrl: chains.defaultPrivateRpcUrl,
            builderRpcUrls: chains.builderRpcUrls,
          })
          .from(chains)
          .where(inArray(chains.chainId, ids))
      : [];
  const byId = new Map<number, ChainRow>(
    rows.map((row) => [
      row.chainId,
      {
        name: row.name,
        usePrivateMempoolRpc: chainHasPrivateRelay(row),
        bundleBuilders: builderLabels(row.builderRpcUrls),
      },
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
