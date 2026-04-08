/**
 * Reshape flat args to match ABI struct/tuple parameters.
 *
 * Protocol step handlers flatten all action inputs into a string array.
 * For simple functions (e.g. `balanceOf(address)`) this works fine.
 * For functions with tuple/struct params (e.g. `exactInputSingle(ExactInputSingleParams)`),
 * ethers.js expects a single object argument -- this utility rebuilds it.
 */

type AbiComponent = {
  name: string;
  type: string;
};

type AbiInput = {
  name: string;
  type: string;
  components?: AbiComponent[];
};

type FunctionAbiEntry = {
  inputs?: AbiInput[];
};

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

function buildTupleArg(
  components: AbiComponent[],
  args: unknown[],
  cursor: number
): { value: Record<string, unknown>; nextCursor: number } {
  const obj: Record<string, unknown> = {};
  let pos = cursor;
  for (const component of components) {
    obj[component.name] = pos < args.length ? args[pos] : undefined;
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
