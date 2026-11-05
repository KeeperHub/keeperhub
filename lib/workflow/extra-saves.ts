/**
 * Saves that ride along with the workflow's own, such as its alert settings:
 * the toolbar's Save (and the flush before a run) sends them too, at once.
 */
type Flush = () => Promise<boolean>;

const flushes = new Set<Flush>();

/** Adds a pending-save flush; returns the function that takes it out again. */
export function registerExtraSave(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Sends every pending extra save now; false when any of them failed. */
export async function flushExtraSaves(): Promise<boolean> {
  const results = await Promise.all([...flushes].map((flush) => flush()));
  return results.every(Boolean);
}
