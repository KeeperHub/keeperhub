import { type AbiItemComponent, findAbiFunction } from "@/lib/abi/utils";

export type AbiFunctionInput = {
  name: string;
  type: string;
  components?: AbiItemComponent[];
  /** Set for event inputs: whether the parameter is indexed. */
  indexed?: boolean;
};

/**
 * The ABI is user-pasted JSON, so `type` is only a compile-time guarantee.
 * An input without one cannot be rendered or encoded, and tuple components
 * are checked the same way because they drive their own input renderers.
 */
export function isValidAbiInput(input: unknown): boolean {
  if (!input || typeof input !== "object") {
    return false;
  }

  const { type, components } = input as {
    type?: unknown;
    components?: unknown;
  };

  if (typeof type !== "string" || type === "") {
    return false;
  }

  if (components === undefined) {
    return !type.startsWith("tuple");
  }

  return Array.isArray(components) && components.every(isValidAbiInput);
}

export type ResolvedFunctionInputs = {
  inputs: AbiFunctionInput[];
  /**
   * The ABI could not be read well enough to render a complete argument list.
   * Callers must surface this rather than rendering `inputs`, which is empty
   * here: a short list would encode an incomplete call.
   */
  malformed: boolean;
};

const EMPTY: ResolvedFunctionInputs = { inputs: [], malformed: false };
const MALFORMED: ResolvedFunctionInputs = { inputs: [], malformed: true };

export function resolveFunctionInputs(
  abiValue: string | undefined | null,
  functionValue: string | undefined | null
): ResolvedFunctionInputs {
  if (!(abiValue?.trim() && functionValue?.trim())) {
    return EMPTY;
  }

  let abi: unknown;
  try {
    abi = JSON.parse(abiValue);
  } catch {
    return MALFORMED;
  }

  if (!Array.isArray(abi)) {
    return MALFORMED;
  }

  const func = findAbiFunction(abi, functionValue);
  if (!func) {
    return EMPTY;
  }

  const inputs = func.inputs;
  if (!Array.isArray(inputs)) {
    return inputs === undefined ? EMPTY : MALFORMED;
  }

  if (!inputs.every(isValidAbiInput)) {
    return MALFORMED;
  }

  return {
    inputs: inputs.map((input) => ({
      name: input.name || "unnamed",
      type: input.type,
      components: input.components,
    })),
    malformed: false,
  };
}

/**
 * Resolve the inputs of an *event* entry in a user-pasted ABI, for indexed
 * argument filtering (eth_getLogs topics).
 *
 * Event counterpart of `resolveFunctionInputs`: looks up `type === "event"`
 * entries by name and returns only the *indexed* inputs, in ABI order, each
 * flagged `indexed: true`. The returned list is positional over the indexed
 * inputs only -- non-indexed parameters can never become topics, so they are
 * excluded rather than rendered.
 *
 * IMPORTANT: this is NOT the argument order ethers expects. Both
 * `contract.filters[eventName](...args)` and `Interface#encodeFilterTopics`
 * map arguments positionally over ALL of the event's inputs, so callers must
 * run the result through `expandIndexedArgsToEventPositions` (re-interleaving
 * null wildcards at the non-indexed positions) before passing values to
 * ethers. Feeding this list straight to ethers misaligns whenever a
 * non-indexed input precedes an indexed one.
 *
 * Indexed array and tuple inputs are excluded as well: ethers'
 * `encodeFilterTopics` refuses them outright ("filtering with tuples or
 * arrays not supported"), so rendering a control for them would only break
 * once used.
 *
 * Like `resolveFunctionInputs`, never throws: malformed ABIs yield
 * `{ inputs: [], malformed: true }` so callers render a notice instead of an
 * incomplete argument list.
 */
export function resolveEventInputs(
  abiValue: string | undefined | null,
  eventValue: string | undefined | null
): ResolvedFunctionInputs {
  if (!(abiValue?.trim() && eventValue?.trim())) {
    return EMPTY;
  }

  let abi: unknown;
  try {
    abi = JSON.parse(abiValue);
  } catch {
    return MALFORMED;
  }

  if (!Array.isArray(abi)) {
    return MALFORMED;
  }

  const event = (
    abi as { type?: unknown; name?: unknown; inputs?: unknown }[]
  ).find(
    (item) =>
      item != null &&
      typeof item === "object" &&
      item.type === "event" &&
      item.name === eventValue
  );
  if (!event) {
    return EMPTY;
  }

  const inputs = event.inputs;
  if (!Array.isArray(inputs)) {
    return inputs === undefined ? EMPTY : MALFORMED;
  }

  // Filter to indexed inputs FIRST: a single malformed non-indexed input
  // (some explorer ABIs emit tuples with no `components`) must not hide
  // indexed filters that are themselves fine.
  const indexed = (
    inputs as (AbiFunctionInput & { indexed?: unknown })[]
  ).filter((input) => input.indexed === true);

  if (!indexed.every(isValidAbiInput)) {
    return MALFORMED;
  }

  return {
    inputs: indexed
      // ethers' Interface#encodeFilterTopics refuses indexed arrays and
      // tuples outright, so they are excluded rather than rendered: the
      // control would only break once used.
      .filter(
        (input) => !(input.type.endsWith("]") || input.type.startsWith("tuple"))
      )
      .map((input) => ({
        name: input.name || "unnamed",
        type: input.type,
        components: input.components,
        indexed: true,
      })),
    malformed: false,
  };
}
