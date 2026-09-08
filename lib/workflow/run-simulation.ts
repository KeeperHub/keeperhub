import "server-only";

import {
  type SimulateResult,
  simulateContractCall,
  simulateNativeTransfer,
  simulateTokenTransfer,
} from "@/lib/execute/simulate";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import {
  parseWeb3Connection,
  resolveSignerForNode,
  SIGNER_MODE,
} from "@/lib/safe/signer-resolver";
import { hasTemplateVariables } from "@/lib/utils/template";

const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

const SUPPORTED_ACTION_TYPES = [
  "web3/transfer-funds",
  "web3/transfer-token",
  "web3/write-contract",
] as const;

const SUPPORTED_ACTION_TYPE_SET: ReadonlySet<string> = new Set(
  SUPPORTED_ACTION_TYPES
);

type SupportedActionType = (typeof SUPPORTED_ACTION_TYPES)[number];

export type WorkflowSimulationNode = {
  id: string;
  type?: string;
  data?: {
    label?: string;
    type?: string;
    enabled?: boolean;
    actionType?: string;
    config?: Record<string, unknown>;
  };
};

export type WorkflowSimulationEdge = {
  source?: unknown;
  target?: unknown;
};

export type WorkflowSimulationIssue = {
  code: string;
  message: string;
  parameterPath: string;
  nodeId: string;
  fieldKey?: string;
};

/**
 * Preflight simulation is advisory, so every finding is a warning. There is
 * deliberately no blocking channel here.
 */
export type WorkflowSimulationResult = {
  warnings: WorkflowSimulationIssue[];
  simulatedNodeCount: number;
  skippedNodeCount: number;
};

type RunWorkflowSimulationInput = {
  organizationId: string;
  nodes: WorkflowSimulationNode[];
  edges?: WorkflowSimulationEdge[];
  deadlineAt?: number;
};

export class WorkflowSimulationDeadlineError extends Error {
  constructor() {
    super("Workflow simulation exceeded its deadline");
    this.name = "WorkflowSimulationDeadlineError";
  }
}

type NodeSimulationContext = {
  node: WorkflowSimulationNode;
  nodeIndex: number;
  organizationId: string;
  actionType: SupportedActionType;
  config: Record<string, unknown>;
  hasEarlierReachableWrite: boolean;
};

type NodeSimulationOutcome =
  | { status: "simulated" }
  | { status: "skipped"; warning?: WorkflowSimulationIssue }
  | { status: "failed"; issue: WorkflowSimulationIssue };

type SimulationFailure = Extract<SimulateResult, { success: false }>;

const ACTION_DYNAMIC_FIELDS: Record<SupportedActionType, readonly string[]> = {
  "web3/transfer-funds": [
    "network",
    "amount",
    "recipientAddress",
    "web3Connection",
  ],
  "web3/transfer-token": [
    "network",
    "tokenConfig",
    "tokenAddress",
    "decimals",
    "amount",
    "recipientAddress",
    "web3Connection",
  ],
  "web3/write-contract": [
    "network",
    "contractAddress",
    "abi",
    "abiFunction",
    "functionName",
    "functionArgs",
    "ethValue",
    "web3Connection",
  ],
};

const ACTION_FAILURE_FIELD: Record<SupportedActionType, string> = {
  "web3/transfer-funds": "amount",
  "web3/transfer-token": "amount",
  "web3/write-contract": "abiFunction",
};

const ACTION_DISPLAY_NAME: Record<SupportedActionType, string> = {
  "web3/transfer-funds": "Transfer Native Token",
  "web3/transfer-token": "Transfer ERC20 Token",
  "web3/write-contract": "Write Contract",
};

function reachableNodeIds(
  nodes: WorkflowSimulationNode[],
  edges: WorkflowSimulationEdge[] | undefined
): Set<string> | null {
  if (!edges) {
    return null;
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const reachable = new Set<string>();
  const queue = nodes
    .filter((node) => node.type === "trigger" || node.data?.type === "trigger")
    .map((node) => node.id);

  for (const nodeId of queue) {
    reachable.add(nodeId);
  }

  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    if (typeof edge.source !== "string" || typeof edge.target !== "string") {
      continue;
    }
    if (!(nodeIds.has(edge.source) && nodeIds.has(edge.target))) {
      continue;
    }
    const targets = targetsBySource.get(edge.source) ?? [];
    targets.push(edge.target);
    targetsBySource.set(edge.source, targets);
  }

  for (const source of queue) {
    for (const target of targetsBySource.get(source) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  return reachable;
}

function remainingDeadlineMs(deadlineAt: number | undefined): number | null {
  if (deadlineAt === undefined) {
    return null;
  }
  return deadlineAt - Date.now();
}

async function withSimulationDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number | undefined
): Promise<T> {
  const remaining = remainingDeadlineMs(deadlineAt);
  if (remaining === null) {
    return promise;
  }
  if (remaining <= 0) {
    throw new WorkflowSimulationDeadlineError();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new WorkflowSimulationDeadlineError()),
          remaining
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isSupportedActionType(
  actionType: unknown
): actionType is SupportedActionType {
  return (
    typeof actionType === "string" && SUPPORTED_ACTION_TYPE_SET.has(actionType)
  );
}

function issuePath(nodeIndex: number, fieldKey?: string): string {
  const base = `nodes[${nodeIndex}].data.config`;
  return fieldKey ? `${base}.${fieldKey}` : base;
}

function nodeLabel(
  node: WorkflowSimulationNode,
  actionType: SupportedActionType
): string {
  const configuredLabel = node.data?.label?.trim();

  if (configuredLabel && configuredLabel !== actionType) {
    return configuredLabel;
  }

  return ACTION_DISPLAY_NAME[actionType];
}

function usefulRevertReason(result: SimulationFailure): string | null {
  if (result.failureKind !== "revert") {
    return null;
  }

  const reason = result.revertReason.trim();

  if (
    !reason ||
    reason.startsWith("Simulation failed:") ||
    reason.startsWith("Simulation unavailable:") ||
    reason.includes("missing revert data") ||
    reason.includes("CALL_EXCEPTION") ||
    reason.includes('action="') ||
    reason.includes("transaction={")
  ) {
    return null;
  }

  return reason;
}

function revertGuidance(actionType: SupportedActionType): string {
  switch (actionType) {
    case "web3/transfer-funds":
      return "Check the wallet balance, amount, recipient, and gas requirements.";
    case "web3/transfer-token":
      return "Check the token balance, amount, recipient, and contract state.";
    case "web3/write-contract":
      return "Check the contract address, function arguments, value, permissions, and contract state.";
    default:
      return "Check the configured inputs and current on-chain state.";
  }
}

function simulationRevertMessage(
  context: NodeSimulationContext,
  label: string,
  reason: string | null
): string {
  if (context.hasEarlierReachableWrite) {
    if (reason) {
      return `${label} may revert: ${reason}. This may depend on an earlier step in this workflow.`;
    }

    return `${label} may revert. This may depend on an earlier step in this workflow. ${revertGuidance(context.actionType)}`;
  }

  if (reason) {
    return `${label} would revert: ${reason}`;
  }

  return `${label} would revert. ${revertGuidance(context.actionType)}`;
}

/**
 * Message for a preflight failure the simulator attributed to a specific
 * cause, such as a native-value shortfall.
 *
 * The attributed reason names the account to fund and the amount it is short
 * by, neither of which the editor can derive on its own, so it is surfaced
 * verbatim rather than replaced with generic input guidance.
 *
 * An earlier reachable write may be what funds the account. Simulation reads
 * current state, not the state the workflow will have produced by the time
 * this node runs, so the claim is softened the same way a revert is.
 */
function simulationPreflightMessage(
  context: NodeSimulationContext,
  label: string,
  reason: string
): string {
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;

  if (!context.hasEarlierReachableWrite) {
    return `${label} cannot run: ${sentence}`;
  }

  return `${label} may not run: ${sentence} This may depend on an earlier step in this workflow.`;
}

function makeIssue(
  context: NodeSimulationContext,
  input: {
    code: string;
    message: string;
    fieldKey?: string;
  }
): WorkflowSimulationIssue {
  return {
    code: input.code,
    message: input.message,
    parameterPath: issuePath(context.nodeIndex, input.fieldKey),
    nodeId: context.node.id,
    fieldKey: input.fieldKey,
  };
}

function containsTemplate(
  value: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (typeof value === "string") {
    return hasTemplateVariables(value);
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => containsTemplate(entry, seen));
  }

  return Object.values(value as Record<string, unknown>).some((entry) =>
    containsTemplate(entry, seen)
  );
}

function findDynamicField(
  actionType: SupportedActionType,
  config: Record<string, unknown>
): string | undefined {
  return ACTION_DYNAMIC_FIELDS[actionType].find((fieldKey) =>
    containsTemplate(config[fieldKey])
  );
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return "";
}

function optionalStringValue(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized.length > 0 ? normalized : undefined;
}

function jsonStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value);
}

function optionalJsonStringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return;
  }

  return jsonStringValue(value);
}

function optionalDecimals(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    return Number.parseInt(value, 10);
  }

  return;
}

function failureField(context: NodeSimulationContext): string {
  if (context.actionType !== "web3/write-contract") {
    return ACTION_FAILURE_FIELD[context.actionType];
  }

  return optionalStringValue(context.config.abiFunction)
    ? "abiFunction"
    : "functionName";
}

async function resolveEoaEligibility(
  context: NodeSimulationContext,
  chainId: number
): Promise<
  | { eligible: true }
  | { eligible: false; warning: WorkflowSimulationIssue }
  | { eligible: false; error: WorkflowSimulationIssue }
> {
  const rawConnection = optionalStringValue(context.config.web3Connection);

  let parsedConnection: ReturnType<typeof parseWeb3Connection>;

  try {
    parsedConnection = parseWeb3Connection(rawConnection);
  } catch (error) {
    return {
      eligible: false,
      error: makeIssue(context, {
        code: "SIMULATION_INVALID_WEB3_CONNECTION",
        fieldKey: "web3Connection",
        message:
          error instanceof Error
            ? error.message
            : "The Web3 Connection configuration is invalid.",
      }),
    };
  }

  if (parsedConnection.kind === SIGNER_MODE.EOA) {
    return { eligible: true };
  }

  if (parsedConnection.kind === SIGNER_MODE.SAFE) {
    return {
      eligible: false,
      warning: makeIssue(context, {
        code: "SIMULATION_SAFE_SIGNER_UNSUPPORTED",
        fieldKey: "web3Connection",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} uses a Safe connection. The current read-only simulator cannot reproduce the Safe execution path authoritatively, so this step was not simulated.`,
      }),
    };
  }

  try {
    const signerMode = await resolveSignerForNode({
      organizationId: context.organizationId,
      chainId,
      web3Connection: rawConnection,
      recordMetrics: false,
    });

    if (signerMode.kind === SIGNER_MODE.EOA) {
      return { eligible: true };
    }

    return {
      eligible: false,
      warning: makeIssue(context, {
        code: "SIMULATION_SAFE_SIGNER_UNSUPPORTED",
        fieldKey: "web3Connection",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} resolves to a Safe signer. The current read-only simulator cannot reproduce the Safe execution path authoritatively, so this step was not simulated.`,
      }),
    };
  } catch {
    return {
      eligible: false,
      warning: makeIssue(context, {
        code: "SIMULATION_SIGNER_UNAVAILABLE",
        fieldKey: "web3Connection",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} could not resolve its signer for simulation. You can still run the workflow.`,
      }),
    };
  }
}

function runSimulator(context: NodeSimulationContext): Promise<SimulateResult> {
  const { actionType, config, organizationId } = context;

  if (actionType === "web3/transfer-funds") {
    return simulateNativeTransfer({
      organizationId,
      network: stringValue(config.network),
      recipientAddress: stringValue(config.recipientAddress),
      amount: stringValue(config.amount),
    });
  }

  if (actionType === "web3/transfer-token") {
    return simulateTokenTransfer({
      organizationId,
      network: stringValue(config.network),
      tokenConfig: optionalJsonStringValue(config.tokenConfig),
      tokenAddress: optionalStringValue(config.tokenAddress),
      recipientAddress: stringValue(config.recipientAddress),
      amount: stringValue(config.amount),
      decimals: optionalDecimals(config.decimals),
    });
  }

  return simulateContractCall({
    organizationId,
    network: stringValue(config.network),
    contractAddress: stringValue(config.contractAddress),
    abi: jsonStringValue(config.abi),
    functionName:
      optionalStringValue(config.abiFunction) ??
      stringValue(config.functionName),
    functionArgs: optionalJsonStringValue(config.functionArgs),
    value: optionalStringValue(config.ethValue),
  });
}

async function simulateNode(
  context: NodeSimulationContext,
  deadlineAt?: number
): Promise<NodeSimulationOutcome> {
  const dynamicField = findDynamicField(context.actionType, context.config);

  if (dynamicField) {
    return {
      status: "skipped",
      warning: makeIssue(context, {
        code: "SIMULATION_DYNAMIC_INPUT",
        fieldKey: dynamicField,
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} uses a runtime template in ${dynamicField}, so it cannot be simulated before upstream steps run.`,
      }),
    };
  }

  const network = stringValue(context.config.network);

  let chainId: number;

  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return {
      status: "failed",
      issue: makeIssue(context, {
        code: "SIMULATION_INVALID_NETWORK",
        fieldKey: "network",
        message:
          error instanceof Error
            ? error.message
            : "The selected network is invalid.",
      }),
    };
  }

  if (isSolanaChain(chainId)) {
    // Preflight is EVM-only by design; Solana writes are skipped without a
    // warning so valid Solana workflows do not surface issues in the editor.
    return { status: "skipped" };
  }

  const signerEligibility = await withSimulationDeadline(
    resolveEoaEligibility(context, chainId),
    deadlineAt
  );

  if (!signerEligibility.eligible) {
    if ("error" in signerEligibility) {
      return { status: "failed", issue: signerEligibility.error };
    }

    return {
      status: "skipped",
      warning: signerEligibility.warning,
    };
  }

  let result: SimulateResult;

  try {
    result = await withSimulationDeadline(runSimulator(context), deadlineAt);
  } catch (error) {
    if (error instanceof WorkflowSimulationDeadlineError) {
      throw error;
    }
    return {
      status: "skipped",
      warning: makeIssue(context, {
        code: "SIMULATION_UNAVAILABLE",
        fieldKey: "network",
        message: `${nodeLabel(
          context.node,
          context.actionType
        )} could not be simulated because the simulation service was unavailable. You can still run the workflow.`,
      }),
    };
  }

  if (result.success) {
    return { status: "simulated" };
  }

  const label = nodeLabel(context.node, context.actionType);

  if (result.failureKind === "unavailable") {
    return {
      status: "skipped",
      warning: makeIssue(context, {
        code: "SIMULATION_UNAVAILABLE",
        fieldKey: "network",
        message: `${label} could not be simulated because the RPC service was unavailable. You can still run the workflow.`,
      }),
    };
  }

  if (result.failureKind === "revert") {
    const reason = usefulRevertReason(result);

    return {
      status: "failed",
      issue: makeIssue(context, {
        code: "SIMULATION_WOULD_REVERT",
        fieldKey: failureField(context),
        message: simulationRevertMessage(context, label, reason),
      }),
    };
  }

  // A machine-readable `code` means the simulator attributed the failure to a
  // specific cause it could name, currently a native-value shortfall. Such a
  // failure keeps `failureKind: "validation"` because gas estimation rejects
  // the call before the EVM returns revert data, so it reaches here rather
  // than the revert arm above - but the configured inputs are not what is
  // wrong with it, and its reason is the actionable answer.
  if (result.code !== undefined) {
    // No fieldKey: the shortfall is a fact about the funding account, not
    // about any configured field. Naming one would point the issues overlay's
    // parameter path and its Fix button at an input that is not wrong, which
    // is the misdirection this branch exists to remove.
    return {
      status: "failed",
      issue: makeIssue(context, {
        code: "SIMULATION_PREFLIGHT_FAILED",
        message: simulationPreflightMessage(
          context,
          label,
          result.revertReason
        ),
      }),
    };
  }

  return {
    status: "failed",
    issue: makeIssue(context, {
      code: "SIMULATION_INVALID_TRANSACTION",
      fieldKey: failureField(context),
      message: `${label} has invalid transaction inputs. Check the configured network, addresses, amount, and function parameters.`,
    }),
  };
}

/**
 * Simulate eligible static EVM write nodes before an interactive workflow run.
 *
 * This function never signs, broadcasts, creates execution records, reserves
 * spending limits or performs billing operations.
 */
export async function runWorkflowSimulation({
  organizationId,
  nodes,
  edges,
  deadlineAt,
}: RunWorkflowSimulationInput): Promise<WorkflowSimulationResult> {
  const warnings: WorkflowSimulationIssue[] = [];
  let simulatedNodeCount = 0;
  let skippedNodeCount = 0;
  let reachableWriteCount = 0;
  const reachable = reachableNodeIds(nodes, edges);

  for (const [nodeIndex, node] of nodes.entries()) {
    const remaining = remainingDeadlineMs(deadlineAt);
    if (remaining !== null && remaining <= 0) {
      throw new WorkflowSimulationDeadlineError();
    }

    if (reachable && !reachable.has(node.id)) {
      continue;
    }
    if (node.data?.enabled === false) {
      continue;
    }

    if (node.type !== "action" && node.data?.type !== "action") {
      continue;
    }

    const config = node.data?.config;
    const actionType = config?.actionType ?? node.data?.actionType;

    if (!(config && isSupportedActionType(actionType))) {
      continue;
    }

    const outcome = await simulateNode(
      {
        node,
        nodeIndex,
        organizationId,
        actionType,
        config,
        hasEarlierReachableWrite: reachableWriteCount > 0,
      },
      deadlineAt
    );
    reachableWriteCount += 1;

    if (outcome.status === "simulated") {
      simulatedNodeCount += 1;
      continue;
    }

    // A determined failure still only warns: the editor keeps Run Anyway
    // available for every simulation outcome.
    if (outcome.status === "failed") {
      warnings.push(outcome.issue);
      continue;
    }

    skippedNodeCount += 1;
    if (outcome.warning) {
      warnings.push(outcome.warning);
    }
  }

  return {
    warnings,
    simulatedNodeCount,
    skippedNodeCount,
  };
}
