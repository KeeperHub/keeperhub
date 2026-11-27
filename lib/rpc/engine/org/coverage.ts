import { WorkflowTriggerEnum } from "@/lib/workflow/store";
import { resolveRoute } from "../resolve-route";
import {
  ORG_SETTING_ROUTE_ERRORS,
  type RpcRouteErrorCode,
} from "../route-error";
import {
  orgScope,
  parseRpcSelection,
  RPC_SELECTION_CONFIG_KEY,
} from "../scope";
import type { PlatformChainRecord } from "../sources/platform-source";
import {
  type OrgRpcConfig,
  type PrivateMempoolRequest,
  RpcPurpose,
  type RpcSelection,
} from "../types";

const NODE_TYPE_TRIGGER = "trigger";
const NODE_TYPE_ACTION = "action";
/** Where triggers, and actions without their own picker key, keep the network. */
export const DEFAULT_NETWORK_CONFIG_KEY = "network";
const TRIGGER_TYPE_CONFIG_KEY = "triggerType";
const PRIVATE_MEMPOOL_CONFIG_KEY = "usePrivateMempool";
const ACTION_TYPE_CONFIG_KEY = "actionType";

/** Whether an action type calls its chain over RPC; unknown types count. */
/**
 * The config key holding the network an action calls over RPC, or null when
 * the action makes no RPC call.
 */
export type ActionRpcNetworkKey = (actionType: string) => string | null;

const EVERY_ACTION_AT_DEFAULT_KEY: ActionRpcNetworkKey = () =>
  DEFAULT_NETWORK_CONFIG_KEY;

/**
 * Triggers that hold a long-lived listener on their chain. Keep in step with
 * the triggers /api/workflows/events and the block dispatcher listen for.
 */
const SUBSCRIBING_TRIGGERS: ReadonlySet<string> = new Set([
  WorkflowTriggerEnum.EVENT,
  WorkflowTriggerEnum.BLOCK,
  WorkflowTriggerEnum.TEMPO_PAYMENT,
]);

/** One node's use of a chain, as the coverage check sees it. */
export type NodeChainUsage = {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeLabel: string;
  chainId: number;
  purpose: RpcPurpose;
  privateMempool?: PrivateMempoolRequest;
  selection: RpcSelection;
};

export type CoverageWorkflow = {
  id: string;
  name: string;
  nodes: unknown;
};

type NodeShape = {
  id?: unknown;
  data?: {
    type?: unknown;
    label?: unknown;
    config?: Record<string, unknown>;
  };
};

function literalChainId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const chainId = Number(value);
  return Number.isInteger(chainId) ? chainId : null;
}

type NodeRpcUse = { purpose: RpcPurpose; networkKey: string };

function nodeRpcUse(
  type: unknown,
  config: Record<string, unknown>,
  networkKeyOf: ActionRpcNetworkKey
): NodeRpcUse | null {
  if (type === NODE_TYPE_TRIGGER) {
    return SUBSCRIBING_TRIGGERS.has(String(config[TRIGGER_TYPE_CONFIG_KEY]))
      ? {
          purpose: RpcPurpose.SUBSCRIBE,
          networkKey: DEFAULT_NETWORK_CONFIG_KEY,
        }
      : null;
  }
  if (type === NODE_TYPE_ACTION) {
    const actionType = config[ACTION_TYPE_CONFIG_KEY];
    const networkKey =
      typeof actionType === "string"
        ? networkKeyOf(actionType)
        : DEFAULT_NETWORK_CONFIG_KEY;
    if (networkKey === null) {
      return null;
    }
    return {
      purpose:
        config[PRIVATE_MEMPOOL_CONFIG_KEY] === true
          ? RpcPurpose.WRITE
          : RpcPurpose.READ,
      networkKey,
    };
  }
  return null;
}

/**
 * Every chain a workflow's nodes reach. Networks set by a template are only
 * known at run time, so they are skipped here and the resolver refuses them
 * then if they are not covered.
 */
export function chainUsagesOf(
  workflow: CoverageWorkflow,
  networkKeyOf: ActionRpcNetworkKey = EVERY_ACTION_AT_DEFAULT_KEY
): NodeChainUsage[] {
  if (!Array.isArray(workflow.nodes)) {
    return [];
  }
  const usages: NodeChainUsage[] = [];
  for (const node of workflow.nodes as NodeShape[]) {
    const config = node.data?.config;
    if (!config) {
      continue;
    }
    const use = nodeRpcUse(node.data?.type, config, networkKeyOf);
    const chainId = use ? literalChainId(config[use.networkKey]) : null;
    if (!use || chainId === null) {
      continue;
    }
    const { purpose } = use;
    usages.push({
      workflowId: workflow.id,
      workflowName: workflow.name,
      nodeId: String(node.id ?? ""),
      nodeLabel: String(node.data?.label ?? ""),
      chainId,
      purpose,
      privateMempool:
        purpose === RpcPurpose.WRITE ? { strict: true } : undefined,
      selection: parseRpcSelection(config[RPC_SELECTION_CONFIG_KEY]),
    });
  }
  return usages;
}

export type CoverageGap = Omit<
  NodeChainUsage,
  "selection" | "privateMempool"
> & {
  code: RpcRouteErrorCode;
  message: string;
};

export type CoverageInput = {
  organizationId: string;
  usages: readonly NodeChainUsage[];
  /** Chains the organization serves only with its own endpoints. */
  ownRpcOnlyChains: ReadonlySet<number>;
  configs: readonly OrgRpcConfig[];
  platform: ReadonlyMap<number, PlatformChainRecord>;
};

/**
 * Which nodes would fail to get a route under a given policy and set of
 * configs. Runs the real resolver, so the check and execution can never
 * disagree about what is covered.
 */
export function findCoverageGaps(input: CoverageInput): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const usage of input.usages) {
    const record = input.platform.get(usage.chainId);
    const result = resolveRoute({
      chainId: usage.chainId,
      scope: orgScope(input.organizationId, usage.selection),
      chain: record?.chain ?? null,
      platform: record?.endpoints ?? null,
      org: {
        policy: { ownRpcOnly: input.ownRpcOnlyChains.has(usage.chainId) },
        configs: input.configs,
      },
      purpose: usage.purpose,
      privateMempool: usage.privateMempool,
    });
    if (!result.ok && ORG_SETTING_ROUTE_ERRORS.has(result.error.code)) {
      const {
        selection: _selection,
        privateMempool: _private,
        ...node
      } = usage;
      gaps.push({
        ...node,
        code: result.error.code,
        message: result.error.message,
      });
    }
  }
  return gaps;
}
