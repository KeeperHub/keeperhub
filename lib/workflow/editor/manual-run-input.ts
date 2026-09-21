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

/** A declared input field, as the prompt lists it. */
export type ManualRunInputField = {
  /** Dotted path for a key inside an object: `metadata.recipient`. */
  name: string;
  /** The declared JSON Schema type, or `any` when none is declared. */
  type: string;
  required: boolean;
};

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

// Exported for testing: `shouldCollectManualRunInput` is the production caller.
export function hasManualTrigger(nodes: TriggerNodeLike[]): boolean {
  return nodes.some(isManualTrigger);
}

/** Does the schema declare any input field at all?
 *
 * Exported for testing: `shouldCollectManualRunInput` is the production caller.
 */
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
 * of hand-writing JSON and remembering field names.
 *
 * Required properties are deliberately left out. Seeding them made the prefill
 * satisfy its own validation: every required key was present by construction, so
 * a presence check could never fire, and clicking Run on an untouched prompt
 * submitted `{"recipient": ""}` for a field the author had not filled in. That
 * moved the failure downstream, where `{{Manual.data.recipient}}` resolved to an
 * empty string instead of the unresolved-reference error it used to raise.
 *
 * Leaving them out keeps both halves honest at once. The server contract is
 * presence-only, so the key the author's typing produces is what supplies the
 * field, and until they type one the prompt names the field that is still
 * missing. A required property nested inside an optional object is left out the
 * same way, since the nested sample comes from this function too.
 */
export function buildManualRunSample(
  schema: ManualRunInputSchema
): Record<string, unknown> {
  const required = new Set(getRequiredInputNames(schema));
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(asRecord(schema.properties))) {
    if (required.has(name)) {
      continue;
    }
    result[name] = sampleValue(asRecord(property));
  }
  return result;
}

// Exported for testing: the prefill and the input check both call it.
export function getRequiredInputNames(schema: ManualRunInputSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
}

function declaredType(property: ManualRunInputSchema): string {
  const declared = property.type;
  const names = (Array.isArray(declared) ? declared : [declared]).filter(
    (name): name is string => typeof name === "string" && name.length > 0
  );
  return names.length > 0 ? names.join(" | ") : "any";
}

function collectFields(
  schema: ManualRunInputSchema,
  prefix: string
): ManualRunInputField[] {
  const required = new Set(getRequiredInputNames(schema));
  const fields: ManualRunInputField[] = [];
  for (const [name, property] of Object.entries(asRecord(schema.properties))) {
    const path = prefix ? `${prefix}.${name}` : name;
    const shape = asRecord(property);
    fields.push({
      name: path,
      type: declaredType(shape),
      required: required.has(name),
    });
    // A nested object's keys are walked the same way the prefill walks them, so
    // the prompt lists `metadata.recipient` rather than only `metadata`.
    if (Object.keys(asRecord(shape.properties)).length > 0) {
      fields.push(...collectFields(shape, path));
    }
  }
  return fields;
}

/**
 * The declared fields, for the prompt to list next to the JSON it pre-fills.
 *
 * Without this the prompt names a field only after a rejected submit and never
 * names its type, so the author writes key names and shapes from memory - which
 * is the retyping the schema-derived prefill exists to remove. The required
 * flag comes from the enclosing object's own `required` list, so a key required
 * inside a nested object is marked where it actually constrains.
 */
export function listManualRunInputFields(
  schema: ManualRunInputSchema
): ManualRunInputField[] {
  return collectFields(schema, "");
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
 * What the author's input is missing or has declared wrongly.
 *
 * Two rules.
 *
 * **Presence.** A required field is missing when the key is absent entirely. An
 * empty string is a value the author chose: the prefill leaves required fields
 * out, so a required key exists only once they supply one, and `""` is what it
 * holds if they deliberately type nothing. Rejecting `""` was the wrong lever -
 * it made a required `memo` impossible to run empty, and it read as "missing"
 * when the author had deliberately typed nothing, which is the second message
 * the review flagged. A required key inside a nested object is reported by its
 * dotted path, which is the name the prompt lists it under, and it is enforced
 * only once its parent object is present: `metadata: {}` leaves
 * `metadata.recipient` unsatisfied, while omitting an optional `metadata` does
 * not.
 *
 * **Declared types.** A supplied value whose declared JSON type it does not
 * satisfy is refused, naming both sides. The prompt shows the type beside each
 * field, so the check is what makes that column mean something rather than read
 * as decoration: without it `{"chainId": "abc"}` reaches template resolution and
 * can flow into a chain write. A field with no declared type, or one this module
 * cannot check, is not measured.
 *
 * What the server does is unchanged and stays the contract: the listing route in
 * `app/api/mcp/workflows/[slug]/call/route.ts` tests `field in body` at the top
 * level, so presence matches a real caller exactly. The type rule and the nested
 * presence rule are the editor's own, one step stricter than the caller, because
 * the editor is the surface that declares the types to the author.
 */
export function validateManualRunInput(
  schema: ManualRunInputSchema,
  input: Record<string, unknown>
): string[] {
  const present = new Set(Object.keys(input));
  const problems = getRequiredInputNames(schema)
    .filter((name) => !present.has(name))
    .map((name) => `Required input "${name}" is missing.`);
  // The second pass reads only what the author supplied: the type of each value
  // it can see, and the required keys inside an object they did send. A
  // top-level required key is the first pass's business, so the two rules cannot
  // report the same key twice.
  checkProvidedInput(schema, input, "", problems);
  return problems;
}

/** The JSON Schema types a supplied value is measured against. */
const CHECKED_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

/** The declared type names for a field, ignoring any this module cannot check. */
function declaredTypes(shape: Record<string, unknown>): string[] {
  const declared = shape.type;
  return (Array.isArray(declared) ? declared : [declared]).filter(
    (name): name is string =>
      typeof name === "string" && CHECKED_TYPES.has(name)
  );
}

function matchesDeclaredType(name: string, value: unknown): boolean {
  switch (name) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** How the message names a value the author supplied. */
function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    case "undefined":
      return "undefined";
    default:
      return typeof value;
  }
}

/**
 * Problems with the values the author supplied.
 *
 * Two rules, and the second is why this exists. A value whose declared type it
 * does not satisfy is named with both sides, because the prompt shows the type
 * next to the field and until now nothing checked it: `{"chainId": "abc"}`
 * reached template resolution and could flow into a chain write.
 *
 * A required key inside an object is enforced only once that object is present.
 * Omitting an optional `metadata` entirely is not the same mistake as sending
 * `metadata: {}` and leaving `metadata.recipient` unsatisfied, and only the
 * second one leaves a field the prompt marked required without a value.
 *
 * Array items are not walked: a declared `items` type would need the same
 * treatment one level down, and no schema in this repository declares one.
 */
function checkProvidedInput(
  shape: ManualRunInputSchema,
  value: Record<string, unknown>,
  prefix: string,
  problems: string[]
): void {
  for (const [name, property] of Object.entries(asRecord(shape.properties))) {
    if (!(name in value)) {
      continue;
    }
    const path = prefix ? `${prefix}.${name}` : name;
    const declared = asRecord(property);
    const supplied = value[name];
    const types = declaredTypes(declared);
    if (
      types.length > 0 &&
      !types.some((declaredType) => matchesDeclaredType(declaredType, supplied))
    ) {
      problems.push(
        `Input "${path}" must be ${types.join(" or ")}, received ${describeType(supplied)}.`
      );
      continue;
    }
    if (
      supplied === null ||
      typeof supplied !== "object" ||
      Array.isArray(supplied)
    ) {
      continue;
    }
    const nested = supplied as Record<string, unknown>;
    for (const requiredName of getRequiredInputNames(declared)) {
      if (!(requiredName in nested)) {
        problems.push(`Required input "${path}.${requiredName}" is missing.`);
      }
    }
    checkProvidedInput(declared, nested, path, problems);
  }
}
