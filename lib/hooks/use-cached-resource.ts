"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-session memory for data a screen shows again and again.
 *
 * A screen already visited paints from what it last saw and refreshes behind
 * that, so returning to it costs a repaint rather than a skeleton. Keys must
 * carry whatever the data is scoped to -- an organization, a user -- so a
 * change of scope is a miss rather than a stale read.
 *
 * Module-level and unbounded on purpose: entries are small and live only for
 * the tab.
 */
const cache = new Map<string, unknown>();

export function readCachedResource<T>(key: string | null): T | undefined {
  return key ? (cache.get(key) as T | undefined) : undefined;
}

export function writeCachedResource<T>(key: string | null, value: T): void {
  if (key) {
    cache.set(key, value);
  }
}

export function useCachedResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  /** Bump to reload, e.g. when the organization changes. */
  revision = 0
): { data: T | undefined; loading: boolean; refetch: () => Promise<void> } {
  const [data, setData] = useState<T | undefined>(() =>
    readCachedResource<T>(key)
  );

  // Callers build the fetcher inline, so it is a new function every render and
  // cannot be a dependency; it is read through a ref instead.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async (): Promise<void> => {
    const next = await fetcherRef.current();
    writeCachedResource(key, next);
    setData(next);
  }, [key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a reload trigger
  useEffect(() => {
    setData(readCachedResource<T>(key));
    load().catch(() => undefined);
  }, [key, load, revision]);

  return { data, loading: data === undefined, refetch: load };
}
