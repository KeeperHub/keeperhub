import type { NodeExecutionStatus } from "@/lib/errors/execution-status";
import { getReadContractOutputFields } from "@/lib/workflow/editor/action-output-fields";
import { getInputSchemaFields } from "@/lib/workflow/editor/input-schema-fields";
import { getTriggerOutputFields } from "@/lib/workflow/editor/trigger-output-fields";
import type { ExecutionLogEntry, WorkflowNode } from "@/lib/workflow/store";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";
import { findActionById } from "@/plugins/registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionLogsByNodeId = Record<string, ExecutionLogEntry>;

export type SchemaField = {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  itemType?: "string" | "number" | "boolean" | "object";
  fields?: SchemaField[];
  description?: string;
};

export type FieldEntry = { field: string; description: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildExecutionLogsMap(
  logs: Array<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    status: NodeExecutionStatus;
    output?: unknown;
  }>
): ExecutionLogsByNodeId {
  const map: ExecutionLogsByNodeId = {};
  for (const log of logs) {
    map[log.nodeId] = {
      nodeId: log.nodeId,
      nodeName: log.nodeName,
      nodeType: log.nodeType,
      status: log.status,
      output: log.output,
    };
  }
  return map;
}

export function getNodeDisplayName(node: WorkflowNode): string {
  if (node.data.label) {
    return node.data.label;
  }
  if (node.data.type === "action") {
    const actionType = node.data.config?.actionType as string | undefined;
    if (actionType) {
      const action = findActionById(actionType);
      if (action?.label) {
        return action.label;
      }
    }
    return actionType || "HTTP Request";
  }
  if (node.data.type === "trigger") {
    const triggerType = node.data.config?.triggerType as string | undefined;
    return triggerType || "Manual";
  }
  return "Node";
}

export function findDuplicateTemplateLabels(
  displayValue: string,
  nodes: WorkflowNode[]
): string[] {
  const displayRefs = [...displayValue.matchAll(/\{\{([^@}][^}]*)\}\}/g)];
  if (displayRefs.length === 0) {
    return [];
  }

  const labelCounts = new Map<string, number>();
  for (const node of nodes) {
    const name = getNodeDisplayName(node).toLowerCase().trim();
    labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
  }

  const warnings = new Set<string>();
  for (const match of displayRefs) {
    const ref = match[1];
    const dotIndex = ref.indexOf(".");
    const label = (dotIndex === -1 ? ref : ref.substring(0, dotIndex))
      .toLowerCase()
      .trim();
    const count = labelCounts.get(label);
    if (count && count > 1) {
      const displayLabel = dotIndex === -1 ? ref : ref.substring(0, dotIndex);
      warnings.add(displayLabel.trim());
    }
  }
  return [...warnings];
}

export function schemaToFields(
  schema: SchemaField[],
  prefix = ""
): FieldEntry[] {
  const fields: FieldEntry[] = [];
  for (const f of schema) {
    const fieldPath = prefix ? `${prefix}.${f.name}` : f.name;
    const typeLabel = f.type === "array" ? `${f.itemType}[]` : f.type;
    fields.push({ field: fieldPath, description: f.description || typeLabel });
    if (f.type === "object" && f.fields && f.fields.length > 0) {
      fields.push(...schemaToFields(f.fields, fieldPath));
    }
    if (
      f.type === "array" &&
      f.itemType === "object" &&
      f.fields &&
      f.fields.length > 0
    ) {
      fields.push(...schemaToFields(f.fields, `${fieldPath}[0]`));
    }
  }
  return fields;
}

export function isActionType(
  actionType: string | undefined,
  ...matches: string[]
): boolean {
  if (!actionType) {
    return false;
  }
  return matches.some(
    (m) =>
      actionType === m ||
      actionType.endsWith(`/${m.toLowerCase().replace(/\s+/g, "-")}`)
  );
}

export function tryParseSchemaFields(
  raw: string | undefined,
  prefix?: string
): FieldEntry[] | null {
  if (!raw) {
    return null;
  }
  try {
    const schema = JSON.parse(raw) as SchemaField[];
    if (schema.length > 0) {
      return schemaToFields(schema, prefix);
    }
  } catch {
    // invalid JSON, fall through
  }
  return null;
}

export function getActionFields(node: WorkflowNode): FieldEntry[] | null {
  const actionType = node.data.config?.actionType as string | undefined;

  if (actionType === "HTTP Request") {
    return [
      { field: "data", description: "Response data (null on soft failure)" },
      {
        field: "status",
        description: "HTTP status code (null on timeout or connection error)",
      },
      {
        field: "error",
        description:
          "Error message (present only on a soft failure when Fail on error is OFF)",
      },
    ];
  }

  if (actionType === "Database Query") {
    const dbSchema = node.data.config?.dbSchema as string | undefined;
    return (
      tryParseSchemaFields(dbSchema) ?? [
        { field: "rows", description: "Query result rows" },
        { field: "count", description: "Number of rows" },
      ]
    );
  }

  if (isActionType(actionType, "Generate Text", "ai-gateway/generate-text")) {
    const aiSchema = node.data.config?.aiSchema as string | undefined;
    const aiFormat = node.data.config?.aiFormat as string | undefined;
    if (aiFormat === "object") {
      return (
        tryParseSchemaFields(aiSchema, "object") ?? [
          { field: "text", description: "Generated text" },
        ]
      );
    }
    return [{ field: "text", description: "Generated text" }];
  }

  if (isActionType(actionType, "Read Contract", "web3/read-contract")) {
    const abi = node.data.config?.abi as string | undefined;
    const abiFunction = node.data.config?.abiFunction as string | undefined;
    const dynamicFields = getReadContractOutputFields(abi, abiFunction);
    if (dynamicFields.length > 0) {
      return dynamicFields;
    }
  }

  if (actionType === "For Each") {
    return [
      {
        field: "currentItem",
        description: "Current array element (inside loop body)",
      },
      { field: "index", description: "Current iteration index (0-based)" },
      { field: "totalItems", description: "Total number of items in array" },
    ];
  }

  if (actionType === "Collect") {
    return [
      { field: "results", description: "Array of outputs from each iteration" },
      { field: "count", description: "Number of completed iterations" },
    ];
  }

  if (actionType) {
    const action = findActionById(actionType);
    if (action?.outputFields && action.outputFields.length > 0) {
      return action.outputFields;
    }
  }

  return null;
}

export type TriggerFieldOptions = {
  /**
   * Listing inputSchema for the workflow. When present, declared properties
   * are appended as `data.<fieldName>` entries so listed-workflow inputs are
   * available in autocomplete even before an agent has called the workflow.
   */
  inputSchema?: Record<string, unknown> | null;
};

/**
 * Merge declared listing inputSchema fields into a base set of trigger
 * fields without producing duplicates.
 */
function withInputSchemaFields(
  baseFields: FieldEntry[],
  options: TriggerFieldOptions | undefined
): FieldEntry[] {
  const schemaFields = getInputSchemaFields(options?.inputSchema);
  if (schemaFields.length === 0) {
    return baseFields;
  }
  const seen = new Set(baseFields.map((f) => f.field));
  const merged = [...baseFields];
  for (const field of schemaFields) {
    if (seen.has(field.field)) {
      continue;
    }
    merged.push(field);
    seen.add(field.field);
  }
  return merged;
}

export function getTriggerFields(
  node: WorkflowNode,
  options?: TriggerFieldOptions
): FieldEntry[] {
  const triggerType = node.data.config?.triggerType as string | undefined;
  const webhookSchema = node.data.config?.webhookSchema as string | undefined;
  const config = node.data.config || {};

  if (triggerType === WorkflowTriggerEnum.EVENT) {
    const fields = getTriggerOutputFields(triggerType, config);
    if (fields.length > 0) {
      return withInputSchemaFields(fields, options);
    }
  }

  if (triggerType === "Webhook") {
    const parsed = tryParseSchemaFields(webhookSchema);
    if (parsed) {
      return withInputSchemaFields(parsed, options);
    }
  }

  if (triggerType) {
    const fields = getTriggerOutputFields(triggerType, config);
    if (fields.length > 0) {
      return withInputSchemaFields(fields, options);
    }
  }

  return withInputSchemaFields(
    [
      { field: "triggered", description: "Trigger status" },
      { field: "timestamp", description: "Trigger timestamp" },
      { field: "input", description: "Input data" },
    ],
    options
  );
}

export function getCommonFields(
  node: WorkflowNode,
  options?: TriggerFieldOptions
): FieldEntry[] {
  if (node.data.type === "action") {
    return (
      getActionFields(node) ?? [{ field: "data", description: "Output data" }]
    );
  }
  if (node.data.type === "trigger") {
    return getTriggerFields(node, options);
  }
  return [{ field: "data", description: "Output data" }];
}

export function sanitizeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9]/g, "_");
}

export function findActiveAtIndex(text: string): number {
  const templatePattern = /\{\{[^}]+\}\}/g;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(templatePattern)) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }

  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "@") {
      const isInsideTemplate = ranges.some((r) => i >= r.start && i < r.end);
      if (!isInsideTemplate) {
        return i;
      }
    }
  }
  return -1;
}
