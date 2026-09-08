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
export function canonicalType(input: AbiInput): string {
  // The ABI is user-supplied, so `type` can be absent at runtime. Fail loudly
  // rather than fabricating a signature that would encode the wrong call.
  if (typeof input?.type !== "string") {
    throw new Error("ABI input is missing a type");
  }
  if (!input.type.startsWith("tuple")) {
    return input.type;
  }
  // A tuple without its components has no canonical form: returning the raw
  // "tuple" here would hand back the one spelling ethers cannot encode, as a
  // key, a selector and a canonical signature alike. Treat it as malformed.
  if (!Array.isArray(input.components)) {
    throw new Error("ABI tuple input is missing its components");
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
  const types = inputs.map((input) =>
    typeof input === "string" ? input : canonicalType(input)
  );
  const signature = `${name}(${types.join(",")})`;
  return ethers.id(signature).slice(0, 10);
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
 * Canonical signature of a function entry, e.g.
 * `send((uint32,bytes32),address)`. This is the spelling `ethers` accepts.
 *
 * Returns undefined when the entry cannot be canonicalised at all -- the ABI
 * is user-pasted JSON, so an input may be missing its `type` or carry a
 * malformed `components`. Callers treat such an entry as "not a canonical
 * match" and keep looking, rather than failing the whole lookup: one broken
 * entry must not hide the healthy functions next to it.
 */
function canonicalSignature(item: AbiItem): string | undefined {
  try {
    const inputs = Array.isArray(item.inputs) ? item.inputs : [];
    return `${item.name}(${inputs.map((i) => canonicalType(i)).join(",")})`;
  } catch {
    return;
  }
}

/**
 * Signature built from the raw ABI types, the spelling qualified keys were
 * stored in before tuples were expanded. Undefined when any input is missing
 * its `type`, so a corrupt entry cannot be matched by a key that stringifies
 * to the same text.
 */
function legacySignature(item: AbiItem): string | undefined {
  const inputs = Array.isArray(item.inputs) ? item.inputs : [];
  if (!inputs.every((i) => typeof i?.type === "string")) {
    return;
  }
  return `${item.name}(${inputs.map((i) => i.type).join(",")})`;
}

/** Why a qualified key did not resolve to exactly one function. */
export type AbiFunctionResolution =
  | { status: "found"; entry: AbiFunctionItem; canonicalKey: string }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: AbiFunctionItem[] };

/**
 * Resolve a function key to a single ABI entry, reporting *why* it failed.
 *
 * Prefer this over `findAbiFunction` wherever the caller can surface an error,
 * because `undefined` alone cannot tell "no such function" from "this key
 * matches several overloads".
 *
 * Qualified keys are matched canonically first (`send((uint32,bytes32),address)`)
 * and then against the legacy raw spelling (`send(tuple,address)`), which older
 * saved workflows and external API callers still send. A legacy key resolves
 * when it identifies exactly one overload; it is reported as `ambiguous` only
 * when two overloads share the same raw spelling, which is the one case where
 * the choice was never recoverable from what was stored.
 */
export function resolveAbiFunction(
  abi: AbiItem[],
  key: string | undefined | null
): AbiFunctionResolution {
  if (!key) {
    return { status: "not_found" };
  }

  const parenIdx = key.indexOf("(");
  const name = parenIdx === -1 ? key : key.slice(0, parenIdx);

  const named = abi.filter(
    (item): item is AbiFunctionItem =>
      item != null && item.type === "function" && item.name === name
  );

  if (parenIdx === -1) {
    // Plain names keep their long-standing first-match behaviour.
    const entry = named[0];
    return entry
      ? {
          status: "found",
          entry,
          canonicalKey: canonicalSignature(entry) ?? key,
        }
      : { status: "not_found" };
  }

  // Every canonical match spells the same signature, so however many entries
  // repeat it -- merged facet ABIs do -- they are one function, not overloads.
  const canonical = named.find((item) => canonicalSignature(item) === key);
  if (canonical) {
    return { status: "found", entry: canonical, canonicalKey: key };
  }

  const legacy = distinctBySignature(
    named.filter((item) => legacySignature(item) === key)
  );
  if (legacy.length === 1) {
    const entry = legacy[0];
    return {
      status: "found",
      entry,
      canonicalKey: canonicalSignature(entry) ?? key,
    };
  }
  if (legacy.length > 1) {
    return { status: "ambiguous", candidates: legacy };
  }

  return { status: "not_found" };
}

/**
 * Collapse entries that spell the same canonical signature to their first
 * occurrence. A legacy key is ambiguous when it matches *different* overloads,
 * not when one function happens to be listed twice.
 */
function distinctBySignature(entries: AbiFunctionItem[]): AbiFunctionItem[] {
  const seen = new Set<string>();
  const distinct: AbiFunctionItem[] = [];
  for (const entry of entries) {
    const signature = canonicalSignature(entry) ?? legacySignature(entry) ?? "";
    if (!seen.has(signature)) {
      seen.add(signature);
      distinct.push(entry);
    }
  }
  return distinct;
}

/**
 * Explain an ambiguous legacy key, naming the overloads to choose between.
 *
 * The stored key is a raw-type signature that two overloads share, so which
 * one the user picked was never recorded. Nothing can recover it -- the message
 * has to send them back to the function selector.
 */
export function describeAmbiguousKey(
  key: string,
  candidates: AbiFunctionItem[]
): string {
  const options = candidates
    .map((c) => canonicalSignature(c) ?? legacySignature(c) ?? c.name)
    .join(", ");
  return `Function '${key}' matches ${candidates.length} overloads in this ABI, so the one to call cannot be determined. Re-select the function to store its full signature: ${options}`;
}

/**
 * Find a function in a parsed ABI by key.
 *
 * The key can be a plain name (`"send"`) or a qualified signature, either
 * canonical (`"send((uint32,bytes32),address)"`) or in the legacy raw spelling
 * (`"send(tuple,address)"`).  Plain names return the first function with that
 * name.  Qualified signatures select one overload.
 *
 * Total by design: it never throws, so the UI helpers that call it outside a
 * try/catch (`resolveFunctionInputs`, `deriveStateMutability`) keep failing
 * closed on a malformed ABI. It returns undefined when a legacy key matches
 * several overloads -- use `resolveAbiFunction` where that needs saying out
 * loud.
 */
export function findAbiFunction(
  abi: AbiItem[],
  key: string | undefined | null
): AbiFunctionItem | undefined {
  const resolution = resolveAbiFunction(abi, key);
  return resolution.status === "found" ? resolution.entry : undefined;
}
