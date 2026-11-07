import { atom } from "jotai";

/**
 * Saves that ride along with the workflow's own, such as its alert settings.
 * Save and Run send them at once; they never change what a run does.
 */
type Flush = () => Promise<boolean>;

const flushes = new Set<Flush>();

/** An unsaved ride-along edit: the Save dot shows it, Run's save check does not. */
export const extraUnsavedAtom = atom(false);
/** Adds a flush that resolves true once its settings are saved; returns its removal. */
export function registerExtraSave(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Sends every pending extra save now; false while any of them is still unsaved. */
export async function flushExtraSaves(): Promise<boolean> {
  const results = await Promise.all([...flushes].map((flush) => flush()));
  return results.every(Boolean);
}
