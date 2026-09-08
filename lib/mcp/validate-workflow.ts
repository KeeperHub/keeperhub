// Pure validator — no DB, no network, no MCP SDK imports. Safe to call
// from tests and from the API route. Web3 + ABI checks land in
// Plans 48-02 and 48-03 as additional exported functions.

import {
  BATCH_WRITE_CONTRACT_ACTION_TYPE,
  isWriteActionType,
} from "@/lib/mcp/action-type";
import {
  findBareAtLiterals,
  isInputSchemaPresent,
} from "@/lib/mcp/listing-validators";
import {
  VALIDATION_ERROR_CODES,
  VALIDATION_WARNING_CODES,
  type ValidationErrorCode,
  type ValidationWarningCode,
} from "@/lib/mcp/validate-workflow-codes";
import {
  chainExists,
  tokenAddressFormat,
} from "@/lib/mcp/validate-workflow-web3";

export type ValidationIssue = {
  code: ValidationErrorCode | ValidationWarningCode;
  message: string;
  parameterPath: string;
};

export type ValidationResult = {
  valid: boolean;
  nodeCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

// Minimal workflow shape the validator needs. Mirrors workflows table
// columns: nodes, edges (read from workflow.edges JSONB or derived from
// the editor doc), inputSchema, outputMapping, isListed, workflowType.
export type ValidatorWorkflow = {
  id: string;
  nodes: unknown[];
  edges: unknown[];
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  isListed: boolean;
  workflowType: "read" | "write";
};

export type ValidateWorkflowOptions = {
  /**
   * Pre-fetched set of enabled chain IDs from the `chains` Drizzle table.
   * Caller is responsible for the DB query (keeps this module pure and
   * unit-testable). When omitted, the chain ID existence check is SKIPPED
   * entirely (no false errors).
   */
  chainIds?: Set<number>;
};

export function validateWorkflow(
  workflow: ValidatorWorkflow,
  opts: ValidateWorkflowOptions = {}
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // VALID-02 structural checks (in spec order)
  runEmptyNodesCheck(workflow, errors);
  const nodeIds = collectNodeIds(workflow.nodes);
  runEdgeRefCheck(workflow, nodeIds, errors);
  runTriggerConfigCheck(workflow, errors);
  runBareAtCheck(workflow, errors);

  // VALID-03 listing-eligibility (only when isListed)
  if (workflow.isListed) {
    runInputSchemaCheck(workflow, errors);
  }
  runOutputMappingCheck(workflow, nodeIds, errors);

  // VALID-04 write-action consistency
  runWriteActionCheck(workflow, errors, warnings);

  // Allowance preflight hint: a write-contract node calling an
  // allowance-consuming method with no check-allowance node in the workflow.
  runAllowancePreflightCheck(workflow, warnings);

  // VALID-05: chain ID existence — only when caller pre-fetched chainIds.
  // Per-node check mitigates Pitfall 12 (multi-chain WETH false positives).
  if (opts.chainIds !== undefined) {
    for (const issue of chainExists(workflow.nodes, opts.chainIds)) {
      errors.push(issue);
    }
  }

  // VALID-06: token / contract address format (always runs — no DB needed)
  for (const issue of tokenAddressFormat(workflow.nodes)) {
    errors.push(issue);
  }

  return {
    valid: errors.length === 0,
    nodeCount: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
    errors,
    warnings,
  };
}

// ---- private check helpers ----

function collectNodeIds(nodes: unknown): Set<string> {
  if (!Array.isArray(nodes)) {
    return new Set();
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (
      node !== null &&
      typeof node === "object" &&
      "id" in node &&
      typeof (node as { id: unknown }).id === "string"
    ) {
      ids.add((node as { id: string }).id);
    }
  }
  return ids;
}

function runEmptyNodesCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    errors.push({
      code: VALIDATION_ERROR_CODES.EMPTY_NODES_ARRAY,
      message: "Workflow has no nodes. Add at least one trigger node.",
      parameterPath: "nodes",
    });
  }
}

function runEdgeRefCheck(
  workflow: ValidatorWorkflow,
  nodeIds: Set<string>,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.edges)) {
    return;
  }
  for (const [idx, edge] of workflow.edges.entries()) {
    if (edge === null || typeof edge !== "object") {
      continue;
    }
    const e = edge as { source?: unknown; target?: unknown };
    if (typeof e.source === "string" && !nodeIds.has(e.source)) {
      errors.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_EDGE_REFERENCE,
        message: `Edge ${idx} source "${e.source}" references a nodeId that is not in nodes[]`,
        parameterPath: `edges[${idx}].source`,
      });
    }
    if (typeof e.target === "string" && !nodeIds.has(e.target)) {
      errors.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_EDGE_REFERENCE,
        message: `Edge ${idx} target "${e.target}" references a nodeId that is not in nodes[]`,
        parameterPath: `edges[${idx}].target`,
      });
    }
  }
}

function runTriggerConfigCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.nodes)) {
    return;
  }
  const hasTrigger = workflow.nodes.some(
    (node) =>
      node !== null &&
      typeof node === "object" &&
      "data" in node &&
      (node as { data?: { type?: unknown } }).data?.type === "trigger"
  );
  if (!hasTrigger) {
    errors.push({
      code: VALIDATION_ERROR_CODES.MISSING_TRIGGER_CONFIG,
      message:
        "Workflow has no trigger node (no node with data.type === 'trigger')",
      parameterPath: "nodes",
    });
  }
}

function runBareAtCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  const literals = findBareAtLiterals(workflow.nodes);
  for (const literal of literals) {
    errors.push({
      code: VALIDATION_ERROR_CODES.BARE_AT_LITERAL_IN_TEMPLATE,
      message: `Bare @ literal "${literal}" found outside a {{...}} wrapper — wrap it as {{${literal}:...}} or remove it`,
      parameterPath: "nodes",
    });
  }
}

function runInputSchemaCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[]
): void {
  if (!isInputSchemaPresent(workflow.inputSchema)) {
    errors.push({
      code: VALIDATION_ERROR_CODES.MISSING_INPUT_SCHEMA_ON_LISTED,
      message:
        "Listed workflow has null inputSchema. Bazaar consumers cannot render or validate inputs without it. An empty {type: 'object'} is acceptable for zero-input workflows.",
      parameterPath: "inputSchema",
    });
  }
}

function runOutputMappingCheck(
  workflow: ValidatorWorkflow,
  nodeIds: Set<string>,
  errors: ValidationIssue[]
): void {
  const { outputMapping } = workflow;
  if (outputMapping === null || typeof outputMapping !== "object") {
    return;
  }

  // Flat shape: `{ nodeId: string, field?/fields?: ... }`. This is what the
  // runtime (applyOutputMapping) reads — it pulls the top-level `nodeId` and
  // picks `field`/`fields` off that node's output. The sibling `field`/`fields`
  // keys NAME output fields, they are not node references, so only `nodeId` is
  // verified. Matches `typeof mapping.nodeId === "string"` in
  // lib/payments/x402/execution-wait.ts.
  const flatNodeId = (outputMapping as { nodeId?: unknown }).nodeId;
  if (typeof flatNodeId === "string") {
    if (!nodeIds.has(flatNodeId)) {
      errors.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_OUTPUT_MAPPING_NODE,
        message: `outputMapping.nodeId references nodeId "${flatNodeId}" which is not present in nodes[]`,
        parameterPath: "outputMapping.nodeId",
      });
    }
    return;
  }

  // Keyed shape: `{ outputKey: <{{@nodeId:Label.field}} template | { nodeId, field } | nodeIdString> }`.
  // Extract any concrete node reference from each value and verify it.
  for (const [key, value] of Object.entries(outputMapping)) {
    const referencedNodeId = extractNodeIdReference(value);
    if (referencedNodeId !== null && !nodeIds.has(referencedNodeId)) {
      errors.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_OUTPUT_MAPPING_NODE,
        message: `outputMapping.${key} references nodeId "${referencedNodeId}" which is not present in nodes[]`,
        parameterPath: `outputMapping.${key}`,
      });
    }
  }
}

// Captures the nodeId from a `{{@nodeId:Label.field}}` template reference.
// Mirrors TEMPLATE_REF_PATTERN in lib/utils/template.ts.
const OUTPUT_MAPPING_TEMPLATE_RE = /\{\{@([^:]+):[^}]+\}\}/;

function extractNodeIdReference(value: unknown): string | null {
  if (typeof value === "string") {
    const templateMatch = value.match(OUTPUT_MAPPING_TEMPLATE_RE);
    if (templateMatch) {
      return templateMatch[1].trim();
    }
    return value;
  }
  if (value !== null && typeof value === "object" && "nodeId" in value) {
    const { nodeId } = value as { nodeId?: unknown };
    return typeof nodeId === "string" ? nodeId : null;
  }
  return null;
}

function getWorkflowActionType(node: unknown): string | undefined {
  if (node === null || typeof node !== "object" || !("data" in node)) {
    return undefined;
  }

  const data = node.data;

  if (data === null || typeof data !== "object") {
    return undefined;
  }

  const config = "config" in data ? data.config : undefined;
  const configActionType =
    config !== null && typeof config === "object" && "actionType" in config
      ? config.actionType
      : undefined;
  const legacyActionType = "actionType" in data ? data.actionType : undefined;
  const actionType = configActionType ?? legacyActionType;

  return typeof actionType === "string"
    ? actionType.replace(":", "/")
    : undefined;
}

function hasWorkflowWriteAction(nodes: unknown[]): boolean {
  return nodes.some((node) => isWriteActionType(getWorkflowActionType(node)));
}

function runWriteActionCheck(
  workflow: ValidatorWorkflow,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  const hasWriteAction =
    Array.isArray(workflow.nodes) && hasWorkflowWriteAction(workflow.nodes);

  if (workflow.workflowType === "write" && !hasWriteAction) {
    errors.push({
      code: VALIDATION_ERROR_CODES.MISSING_WRITE_ACTION_FOR_WRITE_WORKFLOW,
      message:
        'workflowType is "write" but no node has an MCP-callable write actionType.',
      parameterPath: "workflowType",
    });
  }

  if (workflow.workflowType === "read" && hasWriteAction) {
    warnings.push({
      code: VALIDATION_WARNING_CODES.WRITE_ACTION_ON_READ_WORKFLOW,
      message:
        'workflowType is "read" but workflow contains a write-action node. Confirm this is intentional.',
      parameterPath: "workflowType",
    });
  }
}

// ERC-20 transferFrom and ERC-4626 redeem / withdrawFrom move tokens the
// contract must already be approved to spend. Configuring one on a
// write-contract node without a prior allowance check is the common cause of
// runtime "insufficient allowance" reverts. Kept to the methods with explicit
// hackathon evidence — a conservative set avoids false positives.
const ALLOWANCE_SPEND_METHODS = new Set([
  "transferFrom",
  "redeem",
  "withdrawFrom",
]);

// Strips the argument list from an ABI function reference, which may be either
// a bare name ("redeem") or a full signature ("redeem(uint256,address,address)").
const FUNCTION_SIGNATURE_ARGS_PATTERN = /\(.*$/;

type NodeActionConfig = {
  actionType: unknown;
  abiFunction: unknown;
  calls: unknown;
};

function readNodeActionConfig(node: unknown): NodeActionConfig | null {
  if (node === null || typeof node !== "object" || !("data" in node)) {
    return null;
  }
  const { data } = node as { data?: unknown };
  if (data === null || typeof data !== "object" || !("config" in data)) {
    return null;
  }
  const { config } = data as { config?: unknown };
  if (config === null || typeof config !== "object") {
    return null;
  }
  const cfg = config as Record<string, unknown>;
  const actionType =
    cfg.actionType ?? (data as Record<string, unknown>).actionType;
  return { actionType, abiFunction: cfg.abiFunction, calls: cfg.calls };
}

function bareMethodName(abiFunction: unknown): string | null {
  if (typeof abiFunction !== "string") {
    return null;
  }
  const name = abiFunction.replace(FUNCTION_SIGNATURE_ARGS_PATTERN, "").trim();
  return name === "" ? null : name;
}

// batch-write-contract's `calls` config field is a JSON-stringified array of
// { contractAddress, abi, abiFunction, args } entries (see
// plugins/web3/steps/batch-write-contract-core.ts's RawCallEntry). Kept as a
// standalone parse here rather than importing the step's core module, which
// pulls in ethers/DB/RPC deps this pure validator deliberately avoids.
function parseBatchCallAbiFunctions(callsValue: unknown): unknown[] {
  let parsed: unknown = callsValue;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((entry) =>
    entry !== null && typeof entry === "object" && "abiFunction" in entry
      ? (entry as Record<string, unknown>).abiFunction
      : undefined
  );
}

function workflowHasCheckAllowanceNode(nodes: unknown[]): boolean {
  for (const node of nodes) {
    const cfg = readNodeActionConfig(node);
    if (
      typeof cfg?.actionType === "string" &&
      cfg.actionType.includes("check-allowance")
    ) {
      return true;
    }
  }
  return false;
}

function runAllowancePreflightCheck(
  workflow: ValidatorWorkflow,
  warnings: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.nodes)) {
    return;
  }
  if (workflowHasCheckAllowanceNode(workflow.nodes)) {
    return;
  }
  for (const [idx, node] of workflow.nodes.entries()) {
    const cfg = readNodeActionConfig(node);
    if (cfg === null) {
      continue;
    }
    if (cfg.actionType === BATCH_WRITE_CONTRACT_ACTION_TYPE) {
      const abiFunctions = parseBatchCallAbiFunctions(cfg.calls);
      for (const [callIdx, abiFunction] of abiFunctions.entries()) {
        const method = bareMethodName(abiFunction);
        if (method !== null && ALLOWANCE_SPEND_METHODS.has(method)) {
          warnings.push({
            code: VALIDATION_WARNING_CODES.MISSING_ALLOWANCE_PREFLIGHT,
            message: `nodes[${idx}].config.calls[${callIdx}] calls "${method}", which moves tokens via an existing allowance, but the workflow has no web3/check-allowance node. Add an upstream web3/check-allowance node before this write to avoid an "insufficient allowance" revert at execution time. Note: batch calls run with msg.sender set to the Multicall3 contract, not your wallet, so a "${method}" call that relies on a wallet allowance will not work in a batch; keep it in a standalone write node instead.`,
            parameterPath: `nodes[${idx}].config.calls[${callIdx}].abiFunction`,
          });
        }
      }
      continue;
    }
    if (!isWriteActionType(cfg.actionType)) {
      continue;
    }
    const method = bareMethodName(cfg.abiFunction);
    if (method !== null && ALLOWANCE_SPEND_METHODS.has(method)) {
      warnings.push({
        code: VALIDATION_WARNING_CODES.MISSING_ALLOWANCE_PREFLIGHT,
        message: `nodes[${idx}].config calls "${method}", which moves tokens via an existing allowance, but the workflow has no web3/check-allowance node. Add an upstream web3/check-allowance node before this write to avoid an "insufficient allowance" revert at execution time.`,
        parameterPath: `nodes[${idx}].config.abiFunction`,
      });
    }
  }
}
