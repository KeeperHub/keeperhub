/**
 * Manual-run input collection.
 *
 * A workflow with a Manual trigger can declare an `inputSchema` - the same
 * object a listed workflow exposes to API and MCP callers. At runtime the
 * executor merges the request body into the trigger output's `data`
 * (lib/workflow/executor/executor.workflow.ts), which is what
 * `{{Manual.data.<field>}}` resolves against.
 *
 * The editor's Run button posted a hard-coded `{}`, so every such reference
 * resolved to undefined on an editor run while the identical workflow worked
 * when called through the API. Nothing was broken on the server: the route
 * parses `body.input` and the executor merges it. Only the editor never sent
 * anything to merge.
 *
 * These are the pure decisions behind the fix - whether a run needs the author
 * to supply input, what starting payload to show, and what to reject. They are
 * kept out of the overlay and the toolbar so they can be tested as plain
 * functions from `tests/unit/`, which is where this repository tests editor
 * logic: this codebase does not depend on `@testing-library/react`, so a
 * branch that only exists inside a component cannot be covered at all.
 */

export type ManualRunInputSchema = Record<string, unknown>;

/** Minimal node shape: the decision only needs the trigger type. */
type TriggerNodeLike = {
  data?: {
    type?: string;
    config?: Record<string, unknown> | null;
  } | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The trigger types the Run button is a manual entry point for.
 *
 * A workflow can carry several triggers, and only a Manual one takes input
 * from the editor. A Schedule/Webhook/Event workflow runs from its own source,
 * so prompting for listing input there would be asking the author for something
 * the production run never receives.
 */
function isManualTrigger(node: TriggerNodeLike): boolean {
  if (node?.data?.type !== "trigger") {
    return false;
  }
  // Falsy means Manual, matching lib/workflow/editor/template-helpers.ts, which
  // reads the same config as `triggerType || "Manual"`. A persisted `null` or
  // `""` is Manual to the rest of the editor, so a check for `undefined` alone
  // would leave those rows running without ever prompting for input.
  const triggerType = node.data.config?.triggerType;
  return !triggerType || triggerType === "Manual";
}

export function hasManualTrigger(nodes: TriggerNodeLike[]): boolean {
  return nodes.some(isManualTrigger);
}

/** Does the schema declare any input field at all? */
export function hasManualRunInputs(
  schema: ManualRunInputSchema | null | undefined
): boolean {
  if (!schema) {
    return false;
  }
  const properties = asRecord(schema.properties);
  return Object.keys(properties).length > 0;
}

/**
 * Whether the Run button should collect input before starting.
 *
 * Both halves matter: a Manual trigger with no declared input has nothing to
 * collect, and a declared schema on a workflow whose only triggers are
 * automatic is not the editor's to supply.
 */
export function shouldCollectManualRunInput(
  nodes: TriggerNodeLike[],
  schema: ManualRunInputSchema | null | undefined
): boolean {
  return hasManualTrigger(nodes) && hasManualRunInputs(schema);
}

function sampleValue(property: ManualRunInputSchema): unknown {
  if (property.default !== undefined) {
    return property.default;
  }
  const examples = property.examples;
  if (Array.isArray(examples) && examples.length > 0) {
    return examples[0];
  }
  const enumValues = property.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues[0];
  }
  if (property.type === "boolean") {
    return false;
  }
  if (property.type === "number" || property.type === "integer") {
    return 0;
  }
  if (property.type === "array") {
    return [];
  }
  if (property.type === "object") {
    return buildManualRunSample(property);
  }
  return "";
}

/**
 * A starting payload shaped by the schema, so the author edits values instead
 * of hand-writing JSON and remembering field names. Strings start empty, which
 * is why required fields are validated for emptiness below.
 */
export function buildManualRunSample(
  schema: ManualRunInputSchema
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(asRecord(schema.properties))) {
    result[name] = sampleValue(asRecord(property));
  }
  return result;
}

export function getRequiredInputNames(schema: ManualRunInputSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * The body of the editor's execute request.
 *
 * Extracted so the one line that carried the bug has a test: the body was
 * `{ input: {} }` no matter what the author supplied, so the server received an
 * empty object and every `{{Manual.data.<field>}}` resolved to undefined. The
 * shape here (`input` at the top level) is what
 * `app/api/workflow/[workflowId]/execute/route.ts` parses and what the executor
 * merges into the trigger's output data.
 */
export function buildManualRunRequestBody(input: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  return { input };
}

/**
 * Validate the author's input against the schema's `required` list.
 *
 * A required field is missing when the key is absent entirely. An empty string
 * is a value: the prefill only seeds a key the schema declares, so a required
 * string arrives as `""` and stays that way until the author clears the whole
 * entry or sets it. Rejecting `""` was the wrong lever - it made a required
 * `memo` impossible to run empty, and it read as "missing" when the author had
 * deliberately typed nothing, which is the second message the review flagged.
 *
 * Reachability on the server side is unchanged either way: the listing contract
 * in `app/api/mcp/workflows/[slug]/call/route.ts` is presence-only (it tests
 * `field in body`), so the editor now matches a real caller exactly.
 */
export function validateManualRunInput(
  schema: ManualRunInputSchema,
  input: Record<string, unknown>
): string[] {
  const present = new Set(Object.keys(input));
  return getRequiredInputNames(schema)
    .filter((name) => !present.has(name))
    .map((name) => `Required input "${name}" is missing.`);
}
