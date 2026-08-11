import "server-only";

type AbiEntry = {
  type: string;
  name: string;
  inputs?: Array<{ type: string }>;
};

/**
 * Build a fully qualified function key to disambiguate overloaded ABI functions.
 * Returns "deposit(uint256,address)" when the ABI has multiple `deposit` overloads,
 * or the plain function name when unambiguous.
 */
export function getAbiFunctionKey(
  parsedAbi: AbiEntry[],
  functionName: string,
  functionAbi: AbiEntry
): string {
  const matchingFunctions = parsedAbi.filter(
    (item) => item.type === "function" && item.name === functionName
  );

  if (matchingFunctions.length <= 1) {
    return functionName;
  }

  const inputTypes = (functionAbi.inputs ?? []).map((i) => i.type);
  return `${functionName}(${inputTypes.join(",")})`;
}
