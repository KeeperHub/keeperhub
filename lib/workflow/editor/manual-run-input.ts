type InputSchema = Record<string, unknown>;

export function hasManualRunInputs(schema: InputSchema | null): boolean {
  if (!schema || typeof schema.properties !== "object" || !schema.properties) {
    return false;
  }
  return Object.keys(schema.properties).length > 0;
}

export function buildManualRunSample(
  schema: InputSchema
): Record<string, unknown> {
  const properties = asRecord(schema.properties);
  const result: Record<string, unknown> = {};
  for (const [name, rawProperty] of Object.entries(properties)) {
    result[name] = sampleValue(asRecord(rawProperty));
  }
  return result;
}

export function validateManualRunInput(
  schema: InputSchema,
  input: Record<string, unknown>
): string[] {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  return required
    .filter((name) => input[name] === undefined || input[name] === "")
    .map((name) => `Required input "${name}" is missing.`);
}

function sampleValue(schema: InputSchema): unknown {
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (schema.type === "boolean") {
    return false;
  }
  if (schema.type === "number" || schema.type === "integer") {
    return 0;
  }
  if (schema.type === "array") {
    return [];
  }
  if (schema.type === "object") {
    return buildManualRunSample(schema);
  }
  return "";
}

function asRecord(value: unknown): InputSchema {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as InputSchema)
    : {};
}
