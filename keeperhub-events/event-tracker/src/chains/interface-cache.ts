import { createHash } from "node:crypto";
import { ethers } from "ethers";

/**
 * Cache of `ethers.Interface` instances keyed by a stable hash of the ABI.
 * Multiple workflows watching the same contract schema share one parsed
 * Interface; reconnects on a single workflow skip the parse entirely on
 * the second call.
 *
 * `ethers.Interface` is effectively immutable (it exposes decode/encode
 * against a parsed ABI and holds no network state), so sharing across
 * unrelated callers is safe.
 *
 * Bounded via a fixed-size LRU: under the in-process listener model
 * (KEEP-295 Phase 3+), one pod sees every distinct ABI ever registered
 * over its lifetime. Without eviction the cache would grow monotonically.
 * An insertion-ordered Map gives us LRU for free: delete-and-reinsert on
 * hit moves the entry to the end, and when we exceed MAX_CACHE_SIZE we
 * drop the iterator's first entry (the least recently used).
 */

// Sized so an untuned deployment can comfortably hold every unique ABI
// a KeeperHub org has today (low hundreds) with headroom. At ~100-200 KB
// per parsed Interface, 1000 entries caps worst-case RSS at ~200 MB -
// acceptable for event-tracker, and we'll revisit if real pods climb.
const MAX_CACHE_SIZE = 1000;

const cache = new Map<string, ethers.Interface>();

function hashAbi(abi: ethers.InterfaceAbi): string {
  // JSON.stringify is deterministic for the object shapes produced by
  // rawEventsAbi.map(buildEventAbi). If two callers pass semantically
  // equivalent ABIs with different key orderings, they will miss the cache
  // and allocate a second Interface. That is an overhead, not a bug.
  let serialized: string;
  try {
    serialized = JSON.stringify(abi);
  } catch (err) {
    // JSON.stringify throws on circular refs or BigInt. The native error
    // doesn't mention the ABI, so callers hit a confusing stack from
    // inside this module. Re-throw with context.
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `interface-cache: ABI is not JSON-serializable (${cause}); cannot compute cache key`,
    );
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export function getInterface(abi: ethers.InterfaceAbi): ethers.Interface {
  const key = hashAbi(abi);
  const existing = cache.get(key);
  if (existing) {
    // LRU touch: move this entry to the end so it is the newest. Without
    // this the cache degrades to FIFO and evicts frequently-used entries.
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const created = new ethers.Interface(abi);
  if (cache.size >= MAX_CACHE_SIZE) {
    // Map iteration order is insertion order, so the first key is the LRU
    // entry. next() on the keys iterator is O(1) and does not materialise
    // the full list.
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, created);
  return created;
}

export function clearInterfaceCache(): void {
  cache.clear();
}

export function getInterfaceCacheSize(): number {
  return cache.size;
}

export function getInterfaceCacheMaxSize(): number {
  return MAX_CACHE_SIZE;
}
