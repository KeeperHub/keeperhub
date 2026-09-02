/**
 * One ordering for every chain list a user sees. The analytics network filter
 * and the chain picker on a web3 node read from the same comparator, so a
 * reader who learns where a chain sits in one finds it in the same place in the
 * other. Alphabetical by display name, because any other order (chain id,
 * insertion, run volume) moves a chain around as data changes.
 */
const COLLATOR = new Intl.Collator("en-US", { sensitivity: "base" });

export function compareChainNames(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

export function sortChainsByName<T>(
  chains: T[],
  name: (chain: T) => string
): T[] {
  return [...chains].sort((a, b) => compareChainNames(name(a), name(b)));
}
