/**
 * Sanitizes workflow nodes and edges before persisting to the database.
 *
 * Handles two classes of issues:
 * 1. React Flow UI state leaking into stored data (dragging, measured, selected, etc.)
 * 2. MCP/AI producing inconsistent node formats (wrong type separators, config at wrong level)
 * 3. Missing positions. Applies auto-layout when all nodes are at origin
 * 4. Condition config normalization (missing ids, wrong operator formats, field name aliases)
 *
 * Canonical node format expected by the workflow executor:
 *   { id, type: "trigger"|"action", position: {x,y}, data: { label, description, type, config: { actionType, ...params }, status, enabled? } }
 */

import type { Edge, Node } from "@xyflow/react";
import { nanoid } from "nanoid";
import { computeAutoLayout } from "@/lib/auto-layout";
import type { ConditionOperator } from "@/lib/condition-builder-types";

/** Map common MCP/AI operator aliases to canonical ConditionOperator values */
const OPERATOR_ALIASES: Record<string, ConditionOperator> = {
  equals: "===",
  equal: "===",
  eq: "===",
  not_equals: "!==",
  not_equal: "!==",
  neq: "!==",
  greater_than: ">",
  gt: ">",
  greater_than_or_equal: ">=",
  gte: ">=",
  less_than: "<",
  lt: "<",
  less_than_or_equal: "<=",
  lte: "<=",
  starts_with: "startsWith",
  ends_with: "endsWith",
  is_empty: "isEmpty",
  is_not_empty: "isNotEmpty",
  does_not_exist: "doesNotExist",
  matches_regex: "matchesRegex",
};

const KNOWN_DATA_FIELDS = new Set([
  "label",
  "description",
  "type",
  "config",
  "status",
  "enabled",
]);

// ---------------------------------------------------------------------------
// Condition config normalization
// ---------------------------------------------------------------------------

/** The set of valid canonical operators for fast lookup */
const VALID_OPERATORS = new Set<string>([
  "==",
  "===",
  "!=",
  "!==",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "startsWith",
  "endsWith",
  "isEmpty",
  "isNotEmpty",
  "exists",
  "doesNotExist",
  "matchesRegex",
]);

/** Normalize a condition operator string to a canonical ConditionOperator value */
function normalizeOperator(op: unknown): ConditionOperator {
  if (typeof op === "string") {
    if (VALID_OPERATORS.has(op)) {
      return op as ConditionOperator;
    }
    return OPERATOR_ALIASES[op] ?? "===";
  }
  // Handle object-shaped operators (e.g. { key: "equals", label: "Equals" })
  if (typeof op === "object" && op !== null && "key" in op) {
    const key = (op as Record<string, unknown>).key;
    return typeof key === "string" ? (OPERATOR_ALIASES[key] ?? "===") : "===";
  }
  return "===";
}

/** Normalize a single condition rule to the canonical format */
function normalizeConditionRule(
  raw: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: (raw.id as string) || nanoid(),
    leftOperand: String(raw.leftOperand ?? raw.field ?? ""),
    operator: normalizeOperator(raw.operator),
    rightOperand: String(raw.rightOperand ?? raw.value ?? ""),
  };
}

/** Normalize a condition group, recursively handling nested groups */
function normalizeConditionGroup(
  raw: Record<string, unknown>
): Record<string, unknown> {
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  return {
    id: (raw.id as string) || nanoid(),
    logic: raw.logic === "OR" ? "OR" : "AND",
    rules: rules.map((item: Record<string, unknown>) => {
      if ("rules" in item || "logic" in item) {
        return normalizeConditionGroup(item);
      }
      return normalizeConditionRule(item);
    }),
  };
}

/**
 * Normalize conditionConfig inside a Condition node's config.
 * Fixes: missing ids, wrong operator formats, field name aliases, array-shaped groups.
 */
function normalizeConditionConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  if (config.actionType !== "Condition" || !config.conditionConfig) {
    return config;
  }

  const conditionConfig = config.conditionConfig as Record<string, unknown>;
  let group = conditionConfig.group as
    | Record<string, unknown>
    | Record<string, unknown>[];

  // Handle group as array (broken format from some MCP outputs)
  if (Array.isArray(group)) {
    group = {
      id: nanoid(),
      logic: (conditionConfig.logicalOperator as string) ?? "AND",
      rules: group.flatMap((g: Record<string, unknown>) =>
        Array.isArray(g.rules) ? g.rules : [g]
      ),
    };
  }

  if (typeof group !== "object" || group === null) {
    return config;
  }

  return {
    ...config,
    conditionConfig: {
      group: normalizeConditionGroup(group),
    },
  };
}

// ---------------------------------------------------------------------------
// Node format normalization
// ---------------------------------------------------------------------------

/**
 * Detect whether a node.type is a specific step type rather than the generic "trigger"/"action".
 * Step types use slash (e.g. "web3/read-contract") or colon (e.g. "web3:read-contract") separators.
 */
function isSpecificStepType(nodeType: string): boolean {
  return nodeType.includes("/") || nodeType.includes(":");
}

/** Normalize colon-separated step types to slash-separated (web3:read-contract -> web3/read-contract) */
function normalizeStepType(stepType: string): string {
  return stepType.replace(":", "/");
}

/** Determine if a node is a trigger based on various format signals */
function isTriggerNode(node: Record<string, unknown>): boolean {
  if (node.type === "trigger") {
    return true;
  }

  const typeStr = String(node.type ?? "");
  if (
    typeStr === "Schedule" ||
    typeStr.toLowerCase().includes("trigger") ||
    typeStr === "system:schedule" ||
    typeStr === "system/schedule"
  ) {
    return true;
  }

  const data = node.data as Record<string, unknown> | undefined;
  if (data?.type === "trigger") {
    return true;
  }
  const config = data?.config as Record<string, unknown> | undefined;
  if (config?.triggerType !== undefined) {
    return true;
  }

  return false;
}

/**
 * Extract config from a data object where config fields may be at the root level
 * instead of nested inside data.config.
 */
function extractConfig(
  data: Record<string, unknown>,
  existingConfig: Record<string, unknown> | undefined
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...existingConfig };

  // Move any unknown fields from data root into config
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_DATA_FIELDS.has(key) && value !== undefined) {
      config[key] = value;
    }
  }

  return config;
}

function sanitizeNode(raw: Record<string, unknown>): Record<string, unknown> {
  const nodeType = String(raw.type ?? "action");
  const rawData = (raw.data ?? {}) as Record<string, unknown>;
  const isTrigger = isTriggerNode(raw);
  const canonicalType = isTrigger ? "trigger" : "action";

  // Build config: start with existing data.config, then pick up misplaced root-level fields
  let existingConfig = (rawData.config ?? {}) as Record<string, unknown>;

  // If node.type is a specific step type, move it into config.actionType
  if (!isTrigger && isSpecificStepType(nodeType)) {
    const normalized = normalizeStepType(nodeType);
    if (!existingConfig.actionType) {
      existingConfig = { ...existingConfig, actionType: normalized };
    }
  }

  // If the node type is "Schedule" (format 3 trigger), ensure triggerType is set
  if (isTrigger && nodeType === "Schedule" && !existingConfig.triggerType) {
    existingConfig = { ...existingConfig, triggerType: "Schedule" };
  }

  // Extract misplaced config fields from data root level into config
  const rawConfig = extractConfig(rawData, existingConfig);

  // Normalize condition config for Condition nodes (fix ids, operators, field names)
  const config = normalizeConditionConfig(rawConfig);

  // Build clean data object
  const data: Record<string, unknown> = {
    label: rawData.label ?? "",
    type: canonicalType,
    config,
    status: rawData.status ?? "idle",
  };

  if (rawData.description !== undefined) {
    data.description = rawData.description;
  }
  if (rawData.enabled !== undefined) {
    data.enabled = rawData.enabled;
  }

  // Build clean node with only known fields
  const node: Record<string, unknown> = {
    id: raw.id,
    type: canonicalType,
    data,
  };

  // Preserve position if provided (strip to just x/y)
  if (raw.position !== undefined && raw.position !== null) {
    const pos = raw.position as Record<string, unknown>;
    node.position = {
      x: typeof pos.x === "number" ? pos.x : 0,
      y: typeof pos.y === "number" ? pos.y : 0,
    };
  } else {
    node.position = { x: 0, y: 0 };
  }

  return node;
}

function sanitizeEdge(raw: Record<string, unknown>): Record<string, unknown> {
  const edge: Record<string, unknown> = {
    id: raw.id,
    source: raw.source,
    target: raw.target,
  };

  // Preserve optional known fields
  if (raw.type !== undefined) {
    edge.type = raw.type;
  }
  if (raw.sourceHandle !== undefined) {
    edge.sourceHandle = raw.sourceHandle;
  }
  if (raw.targetHandle !== undefined) {
    edge.targetHandle = raw.targetHandle;
  }
  if (raw.label !== undefined) {
    edge.label = raw.label;
  }
  if (raw.data !== undefined) {
    edge.data = raw.data;
  }

  return edge;
}

// ---------------------------------------------------------------------------
// Auto-layout
// ---------------------------------------------------------------------------

/** Check if all nodes are at the same position (e.g. all at origin), meaning no layout was provided */
function needsAutoLayout(sanitizedNodes: Record<string, unknown>[]): boolean {
  if (sanitizedNodes.length <= 1) {
    return false;
  }
  const firstPos = sanitizedNodes[0].position as { x: number; y: number };
  return sanitizedNodes.every((n) => {
    const pos = n.position as { x: number; y: number };
    return pos.x === firstPos.x && pos.y === firstPos.y;
  });
}

/**
 * Sanitize workflow nodes and edges, stripping React Flow UI state and normalizing
 * inconsistent MCP/AI-generated node formats to the canonical structure.
 */
export function sanitizeWorkflowData(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[]
): {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
} {
  const sanitizedNodes = nodes.map(sanitizeNode);
  const sanitizedEdges = edges.map(sanitizeEdge);

  // Apply auto-layout when no meaningful positions were provided
  if (needsAutoLayout(sanitizedNodes)) {
    const positions = computeAutoLayout(
      sanitizedNodes as Node[],
      sanitizedEdges as Edge[]
    );
    for (const node of sanitizedNodes) {
      const pos = positions.get(node.id as string);
      if (pos) {
        node.position = pos;
      }
    }
  }

  return {
    nodes: sanitizedNodes,
    edges: sanitizedEdges,
  };
}
