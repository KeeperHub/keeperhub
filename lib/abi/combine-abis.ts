import { type AbiItemComponent, computeSelector } from "@/lib/abi/utils";
import { ErrorCategory, logUserError } from "@/lib/logging";

/**
 * Get function selector for an ABI item.
 *
 * Goes through computeSelector so tuple parameters expand into their component
 * types. A signature built from the raw `input.type` renders every struct as
 * the literal "tuple", so two different tuple-taking overloads hash to the same
 * value -- and this selector is what combineAbis dedupes facet ABIs on, which
 * would drop one of them from the merged ABI entirely.
 *
 * Returns null for an entry that cannot be canonicalised, which keeps the entry
 * out of deduplication rather than discarding it: the ABI is fetched from an
 * explorer, and one malformed entry must not decide the fate of the functions
 * around it.
 */
function getFunctionSelector(abiItem: {
  type: string;
  name?: string;
  inputs?: Array<{
    type: string;
    name?: string;
    components?: AbiItemComponent[];
  }>;
}): string | null {
  if (abiItem.type !== "function" || !abiItem.name || !abiItem.inputs) {
    return null;
  }
  try {
    return computeSelector(abiItem.name, abiItem.inputs);
  } catch {
    return null;
  }
}

/**
 * Parse and process a single ABI string
 */
function processAbiString(
  abiStr: string,
  seenSelectors: Set<string>
): unknown[] {
  try {
    const abi = JSON.parse(abiStr) as unknown[];
    const items: unknown[] = [];
    let functionCount = 0;
    let duplicateCount = 0;

    for (const item of abi) {
      const abiItem = item as {
        type: string;
        name?: string;
        inputs?: Array<{ type: string; name?: string }>;
      };

      // For functions, check for duplicates by selector
      const selector = getFunctionSelector(abiItem);
      if (selector) {
        functionCount += 1;
        if (seenSelectors.has(selector)) {
          duplicateCount += 1;
          console.log(
            `[Diamond] Skipping duplicate function: ${abiItem.name} (selector: ${selector})`
          );
          continue;
        }
        seenSelectors.add(selector);
      }

      // Include all items (functions, events, errors, etc.)
      items.push(item);
    }

    if (functionCount > 0) {
      const uniqueFunctions = items.filter(
        (i) => (i as { type?: string }).type === "function"
      ).length;
      console.log(
        `[Diamond] Processed ${functionCount} functions (${duplicateCount} duplicates skipped, ${uniqueFunctions} unique)`
      );
    }

    return items;
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Diamond] Failed to parse facet ABI from Etherscan",
      error instanceof Error ? error : new Error(String(error)),
      {
        service: "etherscan",
        component: "diamond-proxy",
      }
    );
    return [];
  }
}

/**
 * Combine multiple ABIs into one, removing duplicates.
 *
 * Used to merge the facet ABIs of a Diamond proxy. Functions are deduplicated
 * by selector across all inputs, in order, so the first facet to declare a
 * function keeps it; events, errors and other entries pass through untouched.
 * A facet that fails to parse contributes nothing and does not affect the
 * others.
 */
export function combineAbis(abis: string[]): string {
  const allItems: unknown[] = [];
  const seenSelectors = new Set<string>();

  for (const abiStr of abis) {
    const items = processAbiString(abiStr, seenSelectors);
    allItems.push(...items);
  }

  return JSON.stringify(allItems);
}
