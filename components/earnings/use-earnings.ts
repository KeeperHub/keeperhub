"use client";

import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  earningsDataAtom,
  earningsErrorAtom,
  earningsLastUpdatedAtom,
  earningsLoadingAtom,
} from "@/lib/atoms/earnings";
import { authClient } from "@/lib/auth-client";
import { EARNINGS_PAGE_SIZE } from "@/lib/earnings/constants";
import type { EarningsSummary } from "@/lib/earnings/types";

type UseEarningsReturn = {
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  page: number;
  setPage: (page: number) => void;
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to fetch earnings";
}

export function useEarnings(): UseEarningsReturn {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgId = activeOrg?.id ?? null;

  const [page, setPage] = useState(1);
  const [loading, setLoading] = useAtom(earningsLoadingAtom);
  const [error, setError] = useAtom(earningsErrorAtom);

  const setData = useSetAtom(earningsDataAtom);
  const setLastUpdated = useSetAtom(earningsLastUpdatedAtom);

  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (): Promise<void> => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    const { signal } = controller;

    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(EARNINGS_PAGE_SIZE),
      });

      const res = await fetch(`/api/earnings?${params.toString()}`, { signal });

      if (signal.aborted) {
        return;
      }

      if (res.status === 401) {
        setError("AUTH_REQUIRED");
        setLoading(false);
        return;
      }

      if (res.status === 403) {
        setError("ORG_REQUIRED");
        setLoading(false);
        return;
      }

      if (!res.ok) {
        throw new Error(`Earnings fetch failed: ${res.status}`);
      }

      const data = (await res.json()) as EarningsSummary;

      if (!signal.aborted) {
        setData(data);
        setLastUpdated(new Date());
        setLoading(false);
      }
    } catch (err: unknown) {
      if (signal.aborted) {
        return;
      }
      setError(toErrorMessage(err));
      setLoading(false);
    }
  }, [page, setLoading, setError, setData, setLastUpdated]);

  useEffect(() => {
    fetchData().catch(() => {
      // initial fetch errors handled in fetchData
    });

    return (): void => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [fetchData]);

  const prevOrgIdRef = useRef(activeOrgId);
  useEffect(() => {
    if (prevOrgIdRef.current === activeOrgId) {
      return;
    }
    prevOrgIdRef.current = activeOrgId;
    fetchData().catch(() => {
      // org-switch refetch errors handled in fetchData
    });
  }, [activeOrgId, fetchData]);

  return { loading, error, refetch: fetchData, page, setPage };
}
