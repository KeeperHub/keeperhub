/**
 * Reshape flat args to match ABI struct/tuple parameters.
 *
 * Protocol step handlers flatten all action inputs into a string array.
 * For simple functions (e.g. `balanceOf(address)`) this works fine.
 * For functions with tuple/struct params (e.g. `exactInputSingle(ExactInputSingleParams)`),
 * ethers.js expects a single object argument -- this utility rebuilds it.
 */

import type { AbiParam, FunctionAbiEntry } from "@/lib/abi/types";

const TEMPLATE_VARIABLE_RE = /^\{\{.+\}\}$/;
const ARRAY_SUFFIX_RE = /\[\d*\]$/;

export type { FunctionAbiEntry } from "@/lib/abi/types";

type AbiComponent = AbiParam;
type AbiInput = AbiParam;

function isTupleInput(input: AbiInput): boolean {
  return (
    input.type === "tuple" &&
    input.components !== undefined &&
    input.components.length > 0
  );
}

function isPreStructuredObject(arg: unknown): boolean {
  return arg !== null && typeof arg === "object" && !Array.isArray(arg);
}

function parseArrayComponentValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function buildTupleArg(
  components: AbiComponent[],
  args: unknown[],
  cursor: number
): { value: Record<string, unknown>; nextCursor: number } {
  const obj: Record<string, unknown> = {};
  let pos = cursor;
  for (const component of components) {
    let val = pos < args.length ? args[pos] : undefined;
    if (component.type.endsWith("[]")) {
      val = parseArrayComponentValue(val);
    }
    obj[component.name] = val;
    pos++;
  }
  return { value: obj, nextCursor: pos };
}

/**
 * Reshape a flat args array to match what ethers.js expects based on the ABI.
 *
 * For each ABI input:
 *   - If type is "tuple" with components: consume N flat args, build { name: value } object
 *   - Otherwise: consume 1 flat arg as-is
 *
 * If args is empty or the ABI has no tuple inputs, the array passes through unchanged.
 */
export function reshapeArgsForAbi(
  args: unknown[],
  functionAbi: FunctionAbiEntry
): unknown[] {
  if (args.length === 0) {
    return args;
  }

  const hasTuple = functionAbi.inputs?.some(isTupleInput);
  if (!hasTuple) {
    return args;
  }

  const reshaped: unknown[] = [];
  let cursor = 0;

  for (const input of functionAbi.inputs ?? []) {
    const currentArg = cursor < args.length ? args[cursor] : undefined;

    if (isTupleInput(input) && !isPreStructuredObject(currentArg)) {
      const result = buildTupleArg(input.components ?? [], args, cursor);
      reshaped.push(result.value);
      cursor = result.nextCursor;
    } else {
      reshaped.push(currentArg);
      cursor++;
    }
  }

  return reshaped;
}

/**
 * Coerce stringly-typed args to their ABI-native types where a string would
 * silently corrupt encoding.
 *
 * Scoped to `bool` on purpose: ethers v6 encodes booleans via JS truthiness
 * (`value ? 1 : 0`), so any non-empty string -- including the literal
 * `"false"` -- becomes `true` without warning. Every other ABI leaf type
 * fails loudly on a malformed string: numerics go through `BigInt()` and
 * throw on non-numeric input or out-of-range values, `address` runs EIP-55
 * checksum validation, and `bytes`/`bytesN` reject wrong lengths or missing
 * `0x` prefixes. Extending coercion beyond `bool` would hide those errors
 * instead of fixing them. Template variables (`{{...}}`) pass through and
 * are resolved later in the pipeline.
 */
export function coerceArgsForAbi(
  args: unknown[],
  functionAbi: FunctionAbiEntry
): unknown[] {
  const inputs = functionAbi.inputs ?? [];
  return args.map((arg, i) => {
    const input = inputs[i];
    if (!input) {
      return arg;
    }
    return coerceValue(arg, input.type, input.components);
  });
}

function coerceValue(
  value: unknown,
  type: string,
  components: AbiComponent[] | undefined
): unknown {
  if (isTemplateVariable(value)) {
    return value;
  }
  if (isArrayType(type)) {
    return coerceArray(value, type, components);
  }
  if (type === "tuple") {
    return coerceTuple(value, components);
  }
  if (type === "bool") {
    return coerceBool(value);
  }
  return value;
}

function coerceArray(
  value: unknown,
  arrayType: string,
  components: AbiComponent[] | undefined
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const elementType = stripArraySuffix(arrayType);
  return value.map((item) => coerceValue(item, elementType, components));
}

function coerceTuple(
  value: unknown,
  components: AbiComponent[] | undefined
): unknown {
  if (!isPreStructuredObject(value)) {
    return value;
  }
  // Start from a shallow copy so keys the user set outside the ABI are
  // preserved. Then overwrite known components with their coerced values.
  // The validator downstream flags typos; silently dropping them here
  // would mask that signal.
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  for (const comp of components ?? []) {
    out[comp.name] = coerceValue(obj[comp.name], comp.type, comp.components);
  }
  return out;
}

function coerceBool(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return value;
}

function isArrayType(type: string): boolean {
  return type.endsWith("]");
}

function stripArraySuffix(type: string): string {
  return type.replace(ARRAY_SUFFIX_RE, "");
}

function isTemplateVariable(value: unknown): boolean {
  return typeof value === "string" && TEMPLATE_VARIABLE_RE.test(value.trim());
}
