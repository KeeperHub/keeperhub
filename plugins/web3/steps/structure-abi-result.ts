// Shared, pure ABI-output structuring for read-contract and batch-read-contract.
// No "use step" directive: safe to export helpers and import from step files.
//
// Maps a decoded contract return (already BigInt-serialized to strings, in
// positional array form) onto the function's ABI outputs, attaching component
// names as object keys recursively. Named components become keys; unnamed
// components fall back to `unnamedOutput<index>`; tuple arrays map element-wise.
// This is what lets downstream steps read `result.liquidityIndex` instead of
// reverse-engineering positional indices for tuple-returning views.

export type AbiOutputParam = {
  name?: string;
  type?: string;
  components?: AbiOutputParam[];
};

function isTupleType(type: string): boolean {
  // Covers "tuple", "tuple[]", and fixed-size "tuple[2]".
  return type.startsWith("tuple");
}

function isArrayType(type: string): boolean {
  return type.endsWith("]");
}

// Strips the trailing array dimension from a type: "tuple[][]" -> "tuple[]",
// "tuple[]" -> "tuple", "tuple[2]" -> "tuple".
const TRAILING_ARRAY_DIM = /\[\d*\]$/;

function structureTuple(value: unknown, components: AbiOutputParam[]): unknown {
  if (!Array.isArray(value)) {
    // Defensive: shape did not decode as a positional tuple; pass through.
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [index, component] of components.entries()) {
    const key = component.name?.trim() || `unnamedOutput${index}`;
    out[key] = structureAbiValue(value[index], component);
  }
  return out;
}

/**
 * Structure a single decoded value against its ABI parameter. Primitives and
 * primitive arrays pass through unchanged; tuples and tuple arrays recurse so
 * nested component names are attached. Arbitrary array depth (e.g. tuple[][])
 * is handled by stripping one dimension per recursion.
 */
export function structureAbiValue(
  value: unknown,
  param: AbiOutputParam
): unknown {
  const type = param.type ?? "";
  const { components } = param;
  if (!(isTupleType(type) && components)) {
    return value;
  }
  if (isArrayType(type)) {
    if (!Array.isArray(value)) {
      return value;
    }
    const elementType = type.replace(TRAILING_ARRAY_DIM, "");
    return value.map((element) =>
      structureAbiValue(element, {
        name: param.name,
        type: elementType,
        components,
      })
    );
  }
  return structureTuple(value, components);
}

/**
 * Names supplied by a protocol definition for outputs the ABI leaves unnamed,
 * positionally aligned with the ABI's output list. A blank or absent entry
 * means "no declared name", leaving the ABI-derived behaviour untouched.
 *
 * Only consulted where the ABI names nothing: an ABI that names an output is
 * always authoritative, so a declared name can never shadow a real one.
 */
export type DeclaredOutputNames = readonly (string | undefined)[];

function resolveOutputKey(
  output: AbiOutputParam,
  index: number,
  declaredNames: DeclaredOutputNames | undefined
): string | undefined {
  const abiName = output.name?.trim();
  if (abiName) {
    return abiName;
  }
  return declaredNames?.[index]?.trim() || undefined;
}

/**
 * Structure the full output list of a function call.
 *
 * `outputValues[i]` must be the serialized value of the i-th ABI output. Each
 * caller normalizes its decode form to this: read-contract auto-unwraps a
 * single output (so it wraps it in a one-element array), while batch-read
 * decodes into an N-element Result already.
 *
 * - 0 outputs: returns the raw values untouched.
 * - 1 output: returns the structured value, wrapped in `{ [name]: value }`
 *   only when the output is named.
 * - N outputs: returns an object keyed by output name (or `unnamedOutput<i>`).
 *
 * `declaredNames` lets a protocol definition name an output the ABI left
 * unnamed, so the template path the builder suggests is the path the value
 * actually lands on. Callers without protocol metadata omit it and get the
 * ABI-only behaviour described above, unchanged.
 */
export function structureAbiOutputs(
  outputValues: unknown[],
  outputs: AbiOutputParam[],
  declaredNames?: DeclaredOutputNames
): unknown {
  if (outputs.length === 0) {
    return outputValues;
  }
  if (outputs.length === 1) {
    const output = outputs[0];
    const structured = structureAbiValue(outputValues[0], output);
    const name = resolveOutputKey(output, 0, declaredNames);
    return name ? { [name]: structured } : structured;
  }
  const out: Record<string, unknown> = {};
  for (const [index, output] of outputs.entries()) {
    const key =
      resolveOutputKey(output, index, declaredNames) ?? `unnamedOutput${index}`;
    out[key] = structureAbiValue(outputValues[index], output);
  }
  return out;
}
