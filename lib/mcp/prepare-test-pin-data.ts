import type { ActionConfigFieldBase, PluginAction } from "@/plugins/registry";
import {
  fieldEnumValues,
  fieldJsonType,
  flattenConfigFields,
  getAllIntegrations,
  isDisplayOnlyField,
  isToggleField,
  toggleDefault,
} from "@/plugins/registry";

/**
 * Per-node pin data schema returned by prepare_test_pin_data MCP tool.
 * Phase 49 / TESTWF-05.
 */
export type PinDataNode = {
  nodeId: string;
  nodeName: string;
  type: string;
  pinSchema: PinDataJsonSchema;
  required: boolean;
};

export type PinDataJsonSchema = {
  type: "object";
  properties: Record<string, PinDataPropertySchema>;
  required: string[];
  additionalProperties: boolean;
};

type PinDataPropertySchema = {
  type: "string" | "number" | "boolean";
  description?: string;
  enum?: string[];
  default?: unknown;
};

/**
 * Workflow node shape used by this module — narrow projection of the
 * full workflow.nodes jsonb column. Only the fields needed for pin
 * schema introspection are read.
 */
export type WorkflowNodeLike = {
  id: string;
  type?: string;
  data?: {
    type?: string;
    label?: string;
    config?: {
      triggerType?: string;
      actionType?: string;
    } & Record<string, unknown>;
  };
};

const FALLBACK_PIN_SCHEMA: PinDataJsonSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
};

/**
 * Returns the pin schema for each node in a workflow. Pure: no DB,
 * no plugin execution, no network calls. Reads from the plugin
 * registry only. Safe to call from a Next.js route handler.
 */
export function preparePinDataForWorkflow(
  nodes: WorkflowNodeLike[]
): PinDataNode[] {
  const actionIndex = buildActionIndex();
  const result: PinDataNode[] = [];

  for (const node of nodes) {
    const action = resolveAction(node, actionIndex);
    const { pinSchema, required } = action
      ? buildPinSchemaForAction(action)
      : { pinSchema: FALLBACK_PIN_SCHEMA, required: false };
    result.push({
      nodeId: node.id,
      nodeName: node.data?.label ?? node.id,
      type: node.type ?? "action",
      pinSchema,
      required,
    });
  }

  return result;
}

/**
 * Build a flat index of every registered action keyed by both its full
 * ID ("integration/slug") and its bare slug. The bare-slug fallback
 * matches legacy workflows whose node data.type may store just the
 * slug instead of the namespaced full ID.
 */
function buildActionIndex(): Map<string, PluginAction> {
  const idx = new Map<string, PluginAction>();

  for (const plugin of getAllIntegrations()) {
    for (const action of plugin.actions) {
      idx.set(`${plugin.type}/${action.slug}`, action);
      if (!idx.has(action.slug)) {
        idx.set(action.slug, action);
      }
    }
  }

  return idx;
}

function resolveAction(
  node: WorkflowNodeLike,
  index: Map<string, PluginAction>
): PluginAction | undefined {
  const actionType = node.data?.config?.actionType ?? node.data?.type;
  if (!actionType) {
    return undefined;
  }
  return index.get(actionType);
}

function buildPinSchemaForAction(action: PluginAction): {
  pinSchema: PinDataJsonSchema;
  required: boolean;
} {
  const flat = flattenConfigFields(action.configFields);
  const properties: Record<string, PinDataPropertySchema> = {};
  const required: string[] = [];

  for (const field of flat) {
    // A field that renders a panel collects no value, so it is not a property
    // an agent can set. The schema is `additionalProperties: false`, which
    // makes listing one worse than useless: it invites a value that the step
    // never reads.
    if (isDisplayOnlyField(field.type)) {
      continue;
    }
    properties[field.key] = buildPropertyForField(field);
    // A key can be declared once per mode; JSON Schema rejects repeats in required.
    if (field.required === true && !required.includes(field.key)) {
      required.push(field.key);
    }
  }

  return {
    pinSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    required: required.length > 0,
  };
}

function buildPropertyForField(
  field: ActionConfigFieldBase
): PinDataPropertySchema {
  const description = field.helpTip ?? field.label;

  // The JSON type comes from the same function the action schema uses.
  const jsonType = fieldJsonType(field.type);
  if (jsonType === "number") {
    return { type: "number", description };
  }

  if (jsonType === "boolean") {
    return isToggleField(field.type)
      ? { type: "boolean", description, default: toggleDefault(field) }
      : { type: "boolean", description };
  }

  // The action schema's closed list comes from the same fieldEnumValues.
  const enumValues = fieldEnumValues(field);
  if (enumValues !== undefined) {
    return { type: "string", description, enum: enumValues };
  }

  // A field that accepts a template cannot be a closed enum here: the
  // schema is `additionalProperties: false`, so an agent deriving the value
  // from an earlier step would have its pin data rejected for a value the
  // step resolves perfectly well.
  if (
    field.type === "select" &&
    field.allowTemplate &&
    field.options !== undefined
  ) {
    return {
      type: "string",
      description: `${description} Accepts one of ${field.options
        .map((option) => option.value)
        .join(", ")}, or a template.`,
    };
  }

  return { type: "string", description };
}
