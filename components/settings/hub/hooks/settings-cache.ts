"use client";

/**
 * Per-session memory for settings sections.
 *
 * Every section refetched from scratch on each visit, so switching back to one
 * you had already opened flashed a skeleton before showing the same rows.
 * Hooks seed their initial state from here and revalidate in the background,
 * so a revisit paints immediately and only genuinely new data changes it.
 *
 * Deliberately module-level and unbounded: entries are small, live only for
 * the tab's lifetime, and are keyed by organization so switching org can never
 * surface another org's data.
 */
const cache = new Map<string, unknown>();

export function cacheRead<T>(key: string | null): T | undefined {
  return key ? (cache.get(key) as T | undefined) : undefined;
}

export function cacheWrite<T>(key: string | null, value: T): void {
  if (key) {
    cache.set(key, value);
  }
}
