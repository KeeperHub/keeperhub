import "server-only";
import {
  type AbiFunctionItem,
  type AbiItem,
  canonicalType,
} from "@/lib/abi/utils";

/**
 * Build a fully qualified function key to disambiguate overloaded ABI functions.
 * Returns "deposit(uint256,address)" when the ABI has multiple `deposit` overloads,
 * or the plain function name when unambiguous.
 *
 * Tuple parameters are expanded into their canonical component types, so an
 * overload taking a struct becomes "swap((address,uint256))" -- the spelling
 * `ethers` accepts. Building it from the raw ABI types instead yields the
 * literal "tuple", which neither encodes nor distinguishes two overloads that
 * differ only inside the struct.
 *
 * Overloads are counted by the resolved entry's own name rather than by
 * `functionName`, because callers pass whatever key was stored -- which is
 * already a qualified signature for anything configured through the function
 * selector. Counting by that string matches no ABI entry, and the key would be
 * handed back unchanged.
 */
export function getAbiFunctionKey(
  parsedAbi: AbiItem[],
  functionName: string,
  functionAbi: AbiFunctionItem
): string {
  const name = functionAbi.name;
  const matchingFunctions = parsedAbi.filter(
    (item) => item?.type === "function" && item.name === name
  );

  if (matchingFunctions.length <= 1) {
    return name;
  }

  const inputs = Array.isArray(functionAbi.inputs) ? functionAbi.inputs : [];
  try {
    return `${name}(${inputs.map((i) => canonicalType(i)).join(",")})`;
  } catch {
    // The ABI is user-supplied and this entry is malformed enough that no
    // canonical signature exists. Fall back to the key as it was passed in:
    // the call still fails, but at the encoder, naming the fragment -- rather
    // than here, silently, against whichever overload happened to be first.
    return functionName;
  }
}
