import { ethers } from "ethers";

/**
 * Expand human-readable ABI fragments such as
 * `"function transfer(address to, uint256 amount)"` into the JSON objects the
 * lookup helpers understand. ethers accepts both spellings in one array, so a
 * caller that used to hand the array straight to ethers has to accept them
 * too once it resolves the function key itself.
 *
 * Object entries pass through untouched, malformed ones included: lookup
 * decides what to make of those. A string ethers cannot parse is dropped,
 * which is what `new ethers.Interface` does with it (it warns and skips), so
 * one broken entry keeps failing on its own instead of taking the healthy
 * functions next to it down with it.
 */
export function normalizeAbiEntries(entries: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      normalized.push(entry);
      continue;
    }
    try {
      normalized.push(JSON.parse(ethers.Fragment.from(entry).format("json")));
    } catch {
      // Skipped, as ethers would skip it. See above.
    }
  }
  return normalized;
}
