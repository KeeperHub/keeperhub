/**
 * Validate args against an ABI function signature before encoding.
 *
 * The UI seeds empty fields with "" so React inputs stay controlled. For
 * non-string ABI types (uint*, int*, address, bool, bytes*, etc.) an empty
 * string is not a valid value and would either crash the encoder or, worse,
 * get silently coerced. This walks the ABI structure and rejects such values
 * with a path-aware error so the failure surfaces cleanly through the step
 * error channel.
 *
 * Template variables (`{{NodeName.value}}`) are passed through untouched at
 * leaf positions -- they are resolved later in the execution pipeline.
 */

type AbiComponent = {
  name: string;
  type: string;
  components?: AbiComponent[];
};

type AbiInput = {
  name: string;
  type: string;
  components?: AbiComponent[];
};

type FunctionAbiEntry = {
  inputs?: AbiInput[];
};

export type ValidationResult = { ok: true } | { ok: false; error: string };

const TEMPLATE_VARIABLE_RE = /^\{\{.+\}\}$/;
const BYTES_TYPE_RE = /^bytes\d*$/;

function isTemplateVariable(value: unknown): boolean {
  return typeof value === "string" && TEMPLATE_VARIABLE_RE.test(value.trim());
}

function stripArraySuffix(type: string): string {
  return type.endsWith("[]") ? type.slice(0, -2) : type;
}

/**
 * Only `string` legitimately holds an empty string. Every other leaf type
 * rejects "" -- including `bytes`/`bytesN`, because ethers BytesLike requires
 * the literal "0x" for empty bytes and silently lets "" fall through to a
 * cryptic encoder error otherwise.
 */
function leafAllowsEmptyString(type: string): boolean {
  return type === "string";
}

function isBytesType(type: string): boolean {
  return BYTES_TYPE_RE.test(type);
}

function validateLeaf(
  value: unknown,
  type: string,
  path: string
): ValidationResult {
  if (isTemplateVariable(value)) {
    return { ok: true };
  }

  if (value === "" && !leafAllowsEmptyString(type)) {
    const hint = isBytesType(type) ? ' (use "0x" for empty bytes)' : "";
    return {
      ok: false,
      error: `${path}: ${type} cannot be empty${hint}`,
    };
  }

  if (value === undefined || value === null) {
    return {
      ok: false,
      error: `${path}: ${type} is missing`,
    };
  }

  return { ok: true };
}

function validateArray(
  value: unknown,
  type: string,
  components: AbiComponent[] | undefined,
  path: string
): ValidationResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${path}: expected array for ${type}` };
  }
  const baseType = stripArraySuffix(type);
  for (let i = 0; i < value.length; i++) {
    const result = validateValue(
      value[i],
      baseType,
      components,
      `${path}[${i}]`
    );
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

function validateTuple(
  value: unknown,
  components: AbiComponent[] | undefined,
  path: string
): ValidationResult {
  if (!components || components.length === 0) {
    return { ok: true };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `${path}: expected object for tuple` };
  }
  const obj = value as Record<string, unknown>;
  for (const comp of components) {
    if (!(comp.name in obj)) {
      return {
        ok: false,
        error: `${path}.${comp.name}: ${comp.type} is missing`,
      };
    }
    const result = validateValue(
      obj[comp.name],
      comp.type,
      comp.components,
      `${path}.${comp.name}`
    );
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

function validateValue(
  value: unknown,
  type: string,
  components: AbiComponent[] | undefined,
  path: string
): ValidationResult {
  if (isTemplateVariable(value)) {
    return { ok: true };
  }
  if (type.endsWith("[]")) {
    return validateArray(value, type, components, path);
  }
  if (type === "tuple") {
    return validateTuple(value, components, path);
  }
  return validateLeaf(value, type, path);
}

export function validateArgsForAbi(
  args: unknown[],
  functionAbi: FunctionAbiEntry
): ValidationResult {
  const inputs = functionAbi.inputs ?? [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const label = input.name ? `${input.name}` : `arg${i}`;
    const result = validateValue(args[i], input.type, input.components, label);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}
