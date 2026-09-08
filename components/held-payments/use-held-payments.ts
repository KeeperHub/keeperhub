"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, heldPaymentApi } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import type { PageMeta } from "@/lib/pagination";
import type {
  HeldPaymentStatus,
  HeldPaymentView,
} from "@/lib/tempo/held-payment-view";

// "all" is the unfiltered default; any other value maps to the API `?status=`.
export type HeldPaymentStatusFilter = HeldPaymentStatus | "all";

export const HELD_PAYMENT_PAGE_SIZES = [5, 15, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;
// Poll while a row is still moving so a background broadcast/reconcile shows up
// without a manual refresh; stops once every visible row is terminal.
const POLL_MS = 4000;
const IN_FLIGHT = new Set<HeldPaymentView["status"]>([
  "pending",
  "broadcasting",
  "broadcast",
]);

type UseHeldPaymentsReturn = {
  payments: HeldPaymentView[];
  meta: PageMeta | null;
  loading: boolean;
  error: string | null;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  search: string;
  setSearch: (q: string) => void;
  status: HeldPaymentStatusFilter;
  setStatus: (status: HeldPaymentStatusFilter) => void;
  refetch: () => Promise<void>;
};

export function useHeldPayments(): UseHeldPaymentsReturn {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgId = activeOrg?.id ?? null;

  const [payments, setPayments] = useState<HeldPaymentView[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_PAGE_SIZE);
  const [search, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatusState] = useState<HeldPaymentStatusFilter>("all");

  const setSearch = useCallback((q: string): void => {
    setSearchInput(q);
    setPage(1);
  }, []);
  const setStatus = useCallback((next: HeldPaymentStatusFilter): void => {
    setStatusState(next);
    setPage(1);
  }, []);
  const setPageSize = useCallback((size: number): void => {
    setPageSizeState(size);
    setPage(1);
  }, []);
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(search),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [search]);

  // On org switch, clear the current org's rows immediately and reset paging so
  // the previous org's data never lingers on screen while the refetch runs.
  const prevOrgRef = useRef(activeOrgId);
  useEffect(() => {
    if (prevOrgRef.current === activeOrgId) {
      return;
    }
    prevOrgRef.current = activeOrgId;
    setPayments([]);
    setMeta(null);
    setPage(1);
    setSearchInput("");
    setDebouncedSearch("");
    setStatusState("all");
    setError(null);
  }, [activeOrgId]);

  const fetchData = useCallback(
    async (opts?: { background?: boolean }): Promise<void> => {
      if (!activeOrgId) {
        setPayments([]);
        setMeta(null);
        setError("OWNER_REQUIRED");
        setLoading(false);
        return;
      }
      if (!opts?.background) {
        setLoading(true);
      }
      try {
        const res = await heldPaymentApi.list({
          page,
          limit: pageSize,
          q: debouncedSearch || undefined,
          status: status === "all" ? undefined : status,
        });
        setPayments(res.items);
        setMeta(res.meta);
        setError(null);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 401) {
          setError("AUTH_REQUIRED");
        } else if (status === 400 || status === 403) {
          setError("OWNER_REQUIRED");
        } else {
          setError(
            err instanceof Error ? err.message : "Failed to load held payments"
          );
        }
      } finally {
        if (!opts?.background) {
          setLoading(false);
        }
      }
    },
    [activeOrgId, page, pageSize, debouncedSearch, status]
  );

  useEffect(() => {
    fetchData().catch(() => {
      // surfaced via setError inside fetchData
    });
  }, [fetchData]);

  const hasInFlight = payments.some((p) => IN_FLIGHT.has(p.status));
  useEffect(() => {
    if (!hasInFlight) {
      return;
    }
    const timer = setInterval(() => {
      fetchData({ background: true }).catch(() => {
        // background poll; errors surface on the next foreground fetch
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [hasInFlight, fetchData]);

  return {
    payments,
    meta,
    loading,
    error,
    page,
    setPage,
    pageSize,
    setPageSize,
    search,
    setSearch,
    status,
    setStatus,
    refetch: fetchData,
  };
}
