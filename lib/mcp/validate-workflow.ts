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
  // The grant side of the same seam runs right after it on the same gate:
  // an approve with no check-allowance upstream, and no earlier approve of
  // the same token to the same spender.
  runAllowanceChecks(workflow, warnings);

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
  contractAddress: unknown;
  functionArgs: unknown;
  tokenConfig: unknown;
  tokenAddress: unknown;
  spenderAddress: unknown;
  amount: unknown;
  abi: unknown;
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
  return {
    actionType,
    abiFunction: cfg.abiFunction,
    calls: cfg.calls,
    contractAddress: cfg.contractAddress,
    functionArgs: cfg.functionArgs,
    tokenConfig: cfg.tokenConfig,
    tokenAddress: cfg.tokenAddress,
    spenderAddress: cfg.spenderAddress,
    amount: cfg.amount,
    abi: cfg.abi,
  };
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

// An action slug that reads an ERC-20 allowance, matched on the slug alone
// because this module resolves no registry.
//
// The contiguous "check-allowance" test alone misses the two allowance reads
// chainlink ships: `ccip-check-bridge-allowance` and `ccip-check-fee-allowance`
// place a qualifier between the verb and the noun, so neither contains the
// substring. Both are `allowance(owner, spender)` reads on an ERC-20
// (protocols/chainlink.ts), the same call `web3/check-allowance` makes, so
// both should gate.
//
// The pattern requires the `check` verb rather than only a terminal
// "allowance". `deriveActionsFromAbi` slugs an un-overridden ABI function as
// its kebab-cased name (lib/abi/protocol-derive.ts), so an ERC-20 extension
// exposing `increaseAllowance` / `decreaseAllowance` would slug to
// "increase-allowance" / "decrease-allowance". Those grant an allowance rather
// than read one and must not gate.
//
// The substring test is kept alongside the pattern so this is purely additive:
// no action type that gates today stops gating.
const CHECK_ALLOWANCE_ACTION_FRAGMENT = "check-allowance";
const CHECK_ALLOWANCE_SLUG_PATTERN = /(?:^|-)check(?:-[a-z0-9]+)*-allowance$/;

function isCheckAllowanceActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  if (actionType.includes(CHECK_ALLOWANCE_ACTION_FRAGMENT)) {
    return true;
  }
  // Action types are "<plugin-or-protocol-slug>/<action-slug>"; match the
  // action slug so a protocol slug can never satisfy the pattern by itself.
  const slug = actionType.slice(actionType.lastIndexOf("/") + 1);
  return CHECK_ALLOWANCE_SLUG_PATTERN.test(slug);
}

function readNodeId(node: unknown): string | null {
  if (node === null || typeof node !== "object" || !("id" in node)) {
    return null;
  }
  const { id } = node as { id?: unknown };
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Whether an allowance-check node gates a given write node.
 *
 * The gate used to be presence-based: any allowance-check node anywhere in the
 * workflow suppressed the warning for every write in the workflow, including a
 * check sitting on a parallel branch that never reaches the write, or one
 * placed after it. Neither ordering prevents the revert the warning is about.
 * It is now reachability over `workflow.edges`: a write is gated only by a
 * check that is actually upstream of it.
 *
 * `incoming` is null when the workflow carries no usable edges. The route
 * passes `row.edges ?? []` (app/api/workflows/[workflowId]/validate/route.ts),
 * so a workflow whose edges were never persisted arrives with an empty array
 * rather than a graph, and under a strict reading nothing would be upstream of
 * anything. The gate falls back to the presence test in that case: less
 * information must not produce a more aggressive warning.
 */
type AllowanceGate = {
  /** An allowance-check node exists somewhere in the workflow. */
  present: boolean;
  /** Ids of the allowance-check nodes. */
  gateIds: Set<string>;
  /** target node id -> source node ids, or null when there is no graph. */
  incoming: Map<string, string[]> | null;
  /** Memoised ancestor sets, keyed by node id. */
  ancestors: Map<string, Set<string>>;
};

function buildIncomingEdges(edges: unknown): Map<string, string[]> | null {
  if (!Array.isArray(edges)) {
    return null;
  }
  const incoming = new Map<string, string[]>();
  for (const rawEdge of edges) {
    if (rawEdge === null || typeof rawEdge !== "object") {
      continue;
    }
    const { source, target } = rawEdge as {
      source?: unknown;
      target?: unknown;
    };
    if (typeof source !== "string" || typeof target !== "string") {
      continue;
    }
    const sources = incoming.get(target);
    if (sources === undefined) {
      incoming.set(target, [source]);
    } else {
      sources.push(source);
    }
  }
  return incoming.size === 0 ? null : incoming;
}

function buildAllowanceGate(workflow: ValidatorWorkflow): AllowanceGate {
  const gateIds = new Set<string>();
  let present = false;
  for (const node of workflow.nodes) {
    if (!isCheckAllowanceActionType(readNodeActionConfig(node)?.actionType)) {
      continue;
    }
    present = true;
    const id = readNodeId(node);
    if (id !== null) {
      gateIds.add(id);
    }
  }
  return {
    present,
    gateIds,
    incoming: buildIncomingEdges(workflow.edges),
    ancestors: new Map(),
  };
}

// Every node that can reach `id` by following edges backwards. `seen` doubles
// as the visited guard, so a cycle in the graph terminates instead of looping.
function ancestorsOf(id: string, gate: AllowanceGate): Set<string> {
  const cached = gate.ancestors.get(id);
  if (cached !== undefined) {
    return cached;
  }
  const seen = new Set<string>();
  const incoming = gate.incoming ?? new Map<string, string[]>();
  const queue = [...(incoming.get(id) ?? [])];
  let current = queue.pop();
  while (current !== undefined) {
    if (seen.has(current)) {
      current = queue.pop();
      continue;
    }
    seen.add(current);
    for (const parent of incoming.get(current) ?? []) {
      if (!seen.has(parent)) {
        queue.push(parent);
      }
    }
    current = queue.pop();
  }
  gate.ancestors.set(id, seen);
  return seen;
}

function isAllowanceGated(gate: AllowanceGate, node: unknown): boolean {
  if (!gate.present) {
    return false;
  }
  // No graph, or gate nodes the graph cannot address by id: fall back to the
  // presence test rather than warn on missing information.
  if (gate.incoming === null || gate.gateIds.size === 0) {
    return true;
  }
  const id = readNodeId(node);
  if (id === null) {
    return true;
  }
  const ancestors = ancestorsOf(id, gate);
  for (const gateId of gate.gateIds) {
    if (ancestors.has(gateId)) {
      return true;
    }
  }
  return false;
}

// Both allowance checks share one gate: the graph walk and its memoised
// ancestor sets are the expensive half, and the two checks ask it the same
// question about different nodes.
function runAllowanceChecks(
  workflow: ValidatorWorkflow,
  warnings: ValidationIssue[]
): void {
  if (!Array.isArray(workflow.nodes)) {
    return;
  }
  const gate = buildAllowanceGate(workflow);
  runAllowancePreflightCheck(workflow.nodes, gate, warnings);
  runApproveGateCheck(workflow.nodes, gate, warnings);
}

function runAllowancePreflightCheck(
  nodes: unknown[],
  gate: AllowanceGate,
  warnings: ValidationIssue[]
): void {
  for (const [idx, node] of nodes.entries()) {
    const cfg = readNodeActionConfig(node);
    if (cfg === null) {
      continue;
    }
    if (cfg.actionType === BATCH_WRITE_CONTRACT_ACTION_TYPE) {
      if (isAllowanceGated(gate, node)) {
        continue;
      }
      const abiFunctions = parseBatchCallAbiFunctions(cfg.calls);
      for (const [callIdx, abiFunction] of abiFunctions.entries()) {
        const method = bareMethodName(abiFunction);
        if (method !== null && ALLOWANCE_SPEND_METHODS.has(method)) {
          warnings.push({
            code: VALIDATION_WARNING_CODES.MISSING_ALLOWANCE_PREFLIGHT,
            message: `nodes[${idx}].config.calls[${callIdx}] calls "${method}", which moves tokens via an existing allowance, but no web3/check-allowance node is upstream of it. Add an upstream web3/check-allowance node before this write to avoid an "insufficient allowance" revert at execution time. Note: batch calls run with msg.sender set to the Multicall3 contract, not your wallet, so a "${method}" call that relies on a wallet allowance will not work in a batch; keep it in a standalone write node instead.`,
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
    // Gate last: the ancestor walk is the expensive half, and only a node that
    // already resolved to a spend method can produce a warning. The batch
    // branch consults it first instead, because every call in `calls[]` shares
    // one gate result.
    if (
      method !== null &&
      ALLOWANCE_SPEND_METHODS.has(method) &&
      !isAllowanceGated(gate, node)
    ) {
      warnings.push({
        code: VALIDATION_WARNING_CODES.MISSING_ALLOWANCE_PREFLIGHT,
        message: `nodes[${idx}].config calls "${method}", which moves tokens via an existing allowance, but no web3/check-allowance node is upstream of it. Add an upstream web3/check-allowance node before this write to avoid an "insufficient allowance" revert at execution time.`,
        parameterPath: `nodes[${idx}].config.abiFunction`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Approve gate: the grant side of the allowance seam.
//
// An approve with no upstream allowance read runs blind: it cannot know whether
// the spender already holds enough allowance, so it cannot skip itself. That
// is worth a hint, and only a hint: this module reads no chain state. What the
// hint can say depends on the configured amount. An unlimited approve ("max"
// on an Approve Token node; MaxUint256 in decimal or hex as the raw second
// argument of a write-contract approve) stays in place once it has landed, so
// every later run re-grants what is already there; an exact-amount approve is consumed by the
// spend after it and is needed every run. The message says which of the two
// it is looking at, and says nothing about redundancy when the amount is a
// template reference.
//
// Covers web3/approve-token and a web3/write-contract whose method is
// `approve`. Protocol nodes are out of scope here: their method is not in the
// config this module reads, and that resolution is its own seam. Batch nodes
// are out for the reason given at approveGrantsOf.
//
// Two gates suppress the hint. An upstream allowance read (the same
// reachability rule the spend-side warning uses), and an upstream approve of
// the same token to the same spender, since the second approve then has a
// grant it can be reasoned about against. Both addresses have to resolve to
// literal values on both nodes for the second gate to apply; a template
// reference or a supported-token id that cannot be compared never satisfies
// it, so less information never hides a warning.
// ---------------------------------------------------------------------------

const APPROVE_TOKEN_ACTION_TYPE = "web3/approve-token";
const APPROVE_METHOD = "approve";
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
// approve-token-core special-cases only "max" (ethers.MaxUint256); every other
// string on an Approve Token node goes through parseUnits in the token's
// decimals, so a decimal MaxUint256 there scales past uint256 and a hex string
// is not a decimal at all. The raw spellings below belong to a write-contract
// approve, whose second argument is already in raw units.
const MAX_UINT256_BIGINT = BigInt(2) ** BigInt(256) - BigInt(1);
const MAX_UINT256 = MAX_UINT256_BIGINT.toString();
const DECIMAL_AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const HEX_AMOUNT_PATTERN = /^0x[0-9a-fA-F]+$/;
const ZERO_AMOUNT_PATTERN = /^0+(\.0+)?$/;
const HUMAN_READABLE_FUNCTION = /^function\s+([A-Za-z_$][\w$]*)\s*\(/;
// Functions no ERC-20 declares. An ABI carrying one is a token where the
// second argument of approve is a token id and allowance has no meaning.
const NON_ERC20_MARKERS = ["ownerOf", "setApprovalForAll"];

// "zero" is a revoke: it is neither blind nor re-granting anything, so it
// does not get the hint at all.
type ApproveAmount = "unlimited" | "exact" | "zero" | "unknown";

type ApproveGrant = {
  /** Lower-cased token contract address, when it resolves to a literal. */
  token: string | null;
  /** Lower-cased spender address, when it resolves to a literal. */
  spender: string | null;
  /** What the approve grants, when the amount is a literal the reader can see. */
  amount: ApproveAmount;
  /** Where the hint should point. */
  parameterPath: string;
};

// The amount on an Approve Token node, as approve-token-core reads it: "max"
// is the one unlimited spelling, a plain decimal is an exact amount in the
// token's units (zero is a revoke), and anything else, a hex string or a
// decimal MaxUint256 included, is a value the action will not send as
// written, so the hint makes no claim about it.
function approveTokenAmountOf(raw: unknown): ApproveAmount {
  if (typeof raw === "number") {
    if (!(Number.isFinite(raw) && Number.isInteger(raw)) || raw < 0) {
      return "unknown";
    }
    return raw === 0 ? "zero" : "exact";
  }
  if (typeof raw !== "string") {
    return "unknown";
  }
  const amount = raw.trim();
  if (amount.toLowerCase() === "max") {
    return "unlimited";
  }
  if (!DECIMAL_AMOUNT_PATTERN.test(amount)) {
    return "unknown";
  }
  return ZERO_AMOUNT_PATTERN.test(amount) ? "zero" : "exact";
}

// The second argument of a write-contract approve, in raw units: MaxUint256
// in decimal or hex is unlimited, zero is a revoke, any other integer is exact.
function approveAmountOf(raw: unknown): ApproveAmount {
  if (typeof raw === "number") {
    if (!(Number.isFinite(raw) && Number.isInteger(raw)) || raw < 0) {
      return "unknown";
    }
    return raw === 0 ? "zero" : "exact";
  }
  if (typeof raw !== "string") {
    return "unknown";
  }
  const amount = raw.trim();
  if (amount.toLowerCase() === "max") {
    return "unlimited";
  }
  if (HEX_AMOUNT_PATTERN.test(amount)) {
    const value = BigInt(amount);
    if (value === BigInt(0)) {
      return "zero";
    }
    return value >= MAX_UINT256_BIGINT ? "unlimited" : "exact";
  }
  if (!DECIMAL_AMOUNT_PATTERN.test(amount)) {
    return "unknown";
  }
  if (ZERO_AMOUNT_PATTERN.test(amount)) {
    return "zero";
  }
  return amount === MAX_UINT256 ? "unlimited" : "exact";
}

// The function names a write-contract node's stored ABI declares, or null
// when there is no parseable ABI. Entries may be JSON fragments or
// human-readable signatures.
function declaredFunctionNames(abi: unknown): Set<string> | null {
  let parsed: unknown = abi;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const names = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry === "string") {
      const match = HUMAN_READABLE_FUNCTION.exec(entry.trim());
      if (match !== null) {
        names.add(match[1]);
      }
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const item = entry as { type?: unknown; name?: unknown };
    if (item.type === "function" && typeof item.name === "string") {
      names.add(item.name);
    }
  }
  return names;
}

type TokenStandard = "erc20" | "not-erc20" | "unknown";

function tokenStandardOf(abi: unknown): TokenStandard {
  const names = declaredFunctionNames(abi);
  if (names === null) {
    return "unknown";
  }
  if (NON_ERC20_MARKERS.some((name) => names.has(name))) {
    return "not-erc20";
  }
  return names.has("allowance") ? "erc20" : "unknown";
}

function literalAddress(value: unknown): string | null {
  return typeof value === "string" && EVM_ADDRESS_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

// The token an approve-token node targets: the custom token's address, or a
// bare address in the legacy tokenAddress field. A platform-listed token is
// identified by id rather than address in the config and cannot be compared
// here, so it resolves to null and never matches.
// Same precedence as parseTokenAddress in transfer-token-core: the legacy
// tokenAddress counts only when there is no tokenConfig at all.
function approveTokenAddress(cfg: NodeActionConfig): string | null {
  let config: unknown = cfg.tokenConfig;
  if (config === undefined || config === null || config === "") {
    return literalAddress(cfg.tokenAddress);
  }
  if (typeof config === "string") {
    const fromString = literalAddress(config);
    if (fromString !== null) {
      return fromString;
    }
    try {
      config = JSON.parse(config);
    } catch {
      return null;
    }
  }
  if (config === null || typeof config !== "object") {
    return null;
  }
  const custom = (config as { customToken?: unknown }).customToken;
  if (custom === null || typeof custom !== "object") {
    return null;
  }
  return literalAddress((custom as { address?: unknown }).address);
}

function parseArgs(args: unknown): unknown[] {
  let parsed: unknown = args;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

// The approve grants a node makes, by node index: one for approve-token, one
// for a write-contract calling approve. A revoke (amount zero) is returned so
// it can suppress a later approve of the same token and spender, whose
// allowance is then known to be zero, but it is never hinted itself.
function approveGrantsOf(idx: number, cfg: NodeActionConfig): ApproveGrant[] {
  if (cfg.actionType === APPROVE_TOKEN_ACTION_TYPE) {
    return [
      {
        token: approveTokenAddress(cfg),
        spender: literalAddress(cfg.spenderAddress),
        amount: approveTokenAmountOf(cfg.amount),
        parameterPath: `nodes[${idx}].config.spenderAddress`,
      },
    ];
  }
  // A batch node is left out on purpose: its calls run with msg.sender set
  // to the Multicall3 contract, so an approve inside one grants Multicall3's
  // allowance, not the wallet's. That is a different defect from a missing
  // read, the batch node's own documentation covers it, and such an approve
  // must not count as an earlier grant for a later approve either.
  if (cfg.actionType === BATCH_WRITE_CONTRACT_ACTION_TYPE) {
    return [];
  }
  if (
    isWriteActionType(cfg.actionType) &&
    bareMethodName(cfg.abiFunction) === APPROVE_METHOD
  ) {
    // approve(address,uint256) is the ERC-20 and the ERC-721 signature. The
    // second argument is an amount only on an ERC-20; on an ERC-721 it is a
    // token id and neither the hint nor its remedy means anything, so the
    // declared ABI decides: a non-ERC-20 marker skips the node, an
    // allowance function lets the amount be read, anything else reads no
    // amount. A second argument of zero is read before that gate: it is a
    // revoke on an ERC-20 and token id zero on an ERC-721, and the hint has
    // nothing to say about either.
    const args = parseArgs(cfg.functionArgs);
    const zero = approveAmountOf(args[1]) === "zero";
    const standard = tokenStandardOf(cfg.abi);
    if (!zero && standard === "not-erc20") {
      return [];
    }
    let amount: ApproveAmount = "unknown";
    if (zero) {
      amount = "zero";
    } else if (standard === "erc20") {
      amount = approveAmountOf(args[1]);
    }
    return [
      {
        token: literalAddress(cfg.contractAddress),
        spender: literalAddress(args[0]),
        amount,
        parameterPath: `nodes[${idx}].config.abiFunction`,
      },
    ];
  }
  return [];
}

/** Token and spender match, whatever either approve's amount is. */
function sameGrant(a: ApproveGrant, b: ApproveGrant): boolean {
  return (
    a.token !== null &&
    a.spender !== null &&
    a.token === b.token &&
    a.spender === b.spender
  );
}

const APPROVE_REMEDY =
  "To skip it when the allowance already covers the amount, add a web3/check-allowance node upstream and a Condition on its allowance output that routes around this approve; the check alone only reads.";

function approveHintMessage(idx: number, grant: ApproveGrant): string {
  const target =
    grant.spender === null ? "its spender" : `spender ${grant.spender}`;
  const lead = `nodes[${idx}].config approves ${target} without reading the current allowance first: no web3/check-allowance node is upstream of it.`;
  switch (grant.amount) {
    case "unlimited":
      return `${lead} This approve is unlimited, so once it has landed every later run re-grants an allowance that is already in place. ${APPROVE_REMEDY}`;
    case "exact":
      return `${lead} This approve is for an exact amount, which the spend after it consumes, so it is needed on every run; this is a hint, not a redundancy claim. ${APPROVE_REMEDY}`;
    default:
      return `${lead} ${APPROVE_REMEDY}`;
  }
}

function runApproveGateCheck(
  nodes: unknown[],
  gate: AllowanceGate,
  warnings: ValidationIssue[]
): void {
  const grantsByNodeId = new Map<string, ApproveGrant[]>();
  const entries: { idx: number; node: unknown; grants: ApproveGrant[] }[] = [];
  for (const [idx, node] of nodes.entries()) {
    const cfg = readNodeActionConfig(node);
    if (cfg === null) {
      continue;
    }
    const grants = approveGrantsOf(idx, cfg);
    if (grants.length === 0) {
      continue;
    }
    entries.push({ idx, node, grants });
    const id = readNodeId(node);
    if (id !== null) {
      grantsByNodeId.set(id, grants);
    }
  }

  for (const { idx, node, grants } of entries) {
    if (isAllowanceGated(gate, node)) {
      continue;
    }
    // A revoke is in the map above so it suppresses a later approve of the
    // same grant - after it the allowance is known to be zero - but it is
    // never hinted itself: it grants nothing and there is nothing to skip.
    if (grants.every((g) => g.amount === "zero")) {
      continue;
    }
    const id = readNodeId(node);
    const upstream =
      id !== null && gate.incoming !== null ? ancestorsOf(id, gate) : null;
    for (const grant of grants) {
      let granted = false;
      if (upstream !== null && id !== null) {
        for (const ancestorId of upstream) {
          // On a cycle every node is an ancestor of every other, itself
          // included; none of them ran earlier. Only a one-way ancestor counts.
          if (ancestorId === id || ancestorsOf(ancestorId, gate).has(id)) {
            continue;
          }
          const earlier = grantsByNodeId.get(ancestorId);
          if (earlier?.some((g) => sameGrant(g, grant))) {
            granted = true;
            break;
          }
        }
      }
      if (granted) {
        continue;
      }
      warnings.push({
        code: VALIDATION_WARNING_CODES.APPROVE_WITHOUT_ALLOWANCE_CHECK,
        message: approveHintMessage(idx, grant),
        parameterPath: grant.parameterPath,
      });
    }
  }
}
