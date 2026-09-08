import { ethers } from "ethers";
import type { AbiParam } from "@/lib/abi/types";

/** Compatibility alias for the canonical AbiParam shape. */
export type AbiItemComponent = AbiParam;

type AbiInput = {
  type: string;
  components?: AbiItemComponent[];
};

/**
 * Build the canonical type string for an ABI input, recursively
 * expanding tuple types into their component types.
 *
 * e.g. a tuple with (uint32, bytes32) becomes "(uint32,bytes32)"
 * and a tuple[] becomes "(uint32,bytes32)[]"
 */
function canonicalType(input: AbiInput): string {
  // The ABI is user-supplied, so `type` can be absent at runtime. Fail loudly
  // rather than fabricating a signature that would encode the wrong call.
  if (typeof input?.type !== "string") {
    throw new Error("ABI input is missing a type");
  }
  if (!(input.type.startsWith("tuple") && input.components)) {
    return input.type;
  }
  const inner = input.components.map((c) => canonicalType(c)).join(",");
  const suffix = input.type.slice("tuple".length);
  return `(${inner})${suffix}`;
}

/**
 * Compute the 4-byte function selector from a name and its inputs.
 * Accepts either full ABI input objects (expands tuples correctly)
 * or plain type strings (for simple non-tuple functions).
 * Returns a hex string like "0xcdffacc6".
 */
export function computeSelector(
  name: string,
  inputs: Array<AbiInput | string>
): string {
  return ethers.id(canonicalSignature(name, inputs)).slice(0, 10);
}

/**
 * Build the canonical signature string a selector is hashed from, e.g.
 * "supply(address,uint256,address,uint16)".
 *
 * Shared with `computeSelector` so a displayed signature and the selector it
 * compiles to are always derived from the same normalization.
 */
export function canonicalSignature(
  name: string,
  inputs: Array<AbiInput | string>
): string {
  const types = inputs.map((input) =>
    typeof input === "string" ? input : canonicalType(input)
  );
  return `${name}(${types.join(",")})`;
}

export type AbiItem = {
  type: string;
  name?: string;
  inputs?: Array<{
    type: string;
    name: string;
    components?: AbiItemComponent[];
  }>;
  outputs?: Array<{ type: string; name?: string }>;
  stateMutability?: string;
};

/** ABI entry narrowed to a function (name is always present). */
export type AbiFunctionItem = AbiItem & { name: string };

/**
 * Find a function in a parsed ABI by key.
 *
 * The key can be a plain name (`"send"`) or a qualified signature
 * (`"send(address,uint256,bytes)"`).  Plain names match when the ABI
 * contains at most one function with that name.  Qualified signatures
 * are used for overloaded functions.
 */
export function findAbiFunction(
  abi: AbiItem[],
  key: string | undefined | null
): AbiFunctionItem | undefined {
  if (!key) {
    return;
  }
  const parenIdx = key.indexOf("(");
  if (parenIdx === -1) {
    return abi.find(
      (item): item is AbiFunctionItem =>
        item != null && item.type === "function" && item.name === key
    );
  }

  const name = key.slice(0, parenIdx);
  const typesStr = key.slice(parenIdx + 1, -1);
  const targetTypes = typesStr === "" ? [] : typesStr.split(",");

  return abi.find((item): item is AbiFunctionItem => {
    if (item == null || item.type !== "function" || item.name !== name) {
      return false;
    }
    const rawInputs = Array.isArray(item.inputs) ? item.inputs : [];
    const inputTypes = rawInputs.map((i) => i?.type);
    if (inputTypes.length !== targetTypes.length) {
      return false;
    }
    return inputTypes.every((t, idx) => t === targetTypes[idx]);
  });
}
