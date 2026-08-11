"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Page, PageMeta } from "@/lib/pagination";

type UsePaginatedResourceResult<T> = {
  items: T[];
  meta: PageMeta | null;
  page: number;
  setPage: (page: number) => void;
  loading: boolean;
  error: boolean;
  reload: () => void;
};

/**
 * Drives any offset-paginated endpoint that returns a `Page<T>`. Owns the
 * page/items/meta/loading/error state so components don't reimplement it.
 *
 * - `fetchPage(page)` is read through a ref, so callers can pass an inline
 *   closure without retriggering fetches.
 * - `resetKey` identifies the query (filters, target id, open state, ...);
 *   changing it resets to page 1 and refetches.
 * - `enabled` gates fetching (e.g. only while a panel is open).
 * - `refetchIntervalMs` silently re-fetches the current page on a timer (no
 *   loading flash), so the list stays fresh while open.
 */
export function usePaginatedResource<T>(
  fetchPage: (page: number) => Promise<Page<T>>,
  resetKey: string,
  options?: {
    enabled?: boolean;
    refetchIntervalMs?: number;
    initialPage?: number;
  }
): UsePaginatedResourceResult<T> {
  const enabled = options?.enabled ?? true;
  const refetchIntervalMs = options?.refetchIntervalMs;
  const [page, setPage] = useState(options?.initialPage ?? 1);
  const [items, setItems] = useState<T[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  // A new query identity snaps back to page 1, but only on an ACTUAL change of
  // resetKey -- not on mount, and not on StrictMode's double-invoked effect --
  // so an initialPage (e.g. seeded from the URL) survives the first render.
  const prevResetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      setPage(1);
    }
  }, [resetKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey/reloadTick are refetch triggers; fetchPage is read via ref
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let active = true;
    setLoading(true);
    setError(false);
    fetchRef
      .current(page)
      .then((res) => {
        if (active) {
          setItems(res.items);
          setMeta(res.meta);
          // The endpoint clamps an out-of-range page (e.g. the page size grew
          // so the current page no longer exists, or rows were deleted) to the
          // last page. Adopt that page so we refetch its real items instead of
          // sitting on an empty page; an in-range page is returned unchanged.
          if (res.meta.page !== page) {
            setPage(res.meta.page);
          }
        }
      })
      .catch(() => {
        if (active) {
          setError(true);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [enabled, page, resetKey, reloadTick]);

  // Silent background refresh of the current page (no loading toggle), so an
  // open list picks up changes made elsewhere without a skeleton flash.
  useEffect(() => {
    if (!(enabled && refetchIntervalMs)) {
      return;
    }
    let cancelled = false;
    const id = setInterval(() => {
      fetchRef
        .current(page)
        .then((res) => {
          if (!cancelled) {
            setItems(res.items);
            setMeta(res.meta);
          }
        })
        .catch(() => {
          // Background refresh: keep the current data on a transient failure.
        });
    }, refetchIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, refetchIntervalMs, page]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  return { items, meta, page, setPage, loading, error, reload };
}
