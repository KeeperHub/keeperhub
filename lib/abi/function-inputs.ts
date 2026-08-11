import { type AbiItemComponent, findAbiFunction } from "@/lib/abi/utils";

export type AbiFunctionInput = {
  name: string;
  type: string;
  components?: AbiItemComponent[];
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
    return true;
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
