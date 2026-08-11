"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import type {
  AnalyticsSummary,
  NetworkBreakdown,
  RunsResponse,
  TimeSeriesBucket,
} from "@/lib/analytics/types";
import {
  analyticsErrorAtom,
  analyticsLastUpdatedAtom,
  analyticsLoadingAtom,
  analyticsNetworksAtom,
  analyticsProjectIdAtom,
  analyticsRangeAtom,
  analyticsRunsAtom,
  analyticsSourceFilterAtom,
  analyticsStatusFilterAtom,
  analyticsSummaryAtom,
  analyticsTimeSeriesAtom,
} from "@/lib/atoms/analytics";
import { authClient } from "@/lib/auth-client";

const POLL_INTERVAL_MS = 10_000;

type UseAnalyticsReturn = {
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

function buildQuery(params: Record<string, string | undefined>): string {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }
  return new URLSearchParams(entries).toString();
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to fetch analytics";
}

type FetchContext = {
  aborted: boolean;
  onAbort: (message: string) => void;
  onError: (message: string) => void;
};

async function processSection<T>(
  promise: Promise<Response>,
  label: string,
  ctx: FetchContext,
  onSuccess: (data: T) => void
): Promise<void> {
  if (ctx.aborted) {
    return;
  }
  const res = await promise;
  if (ctx.aborted) {
    return;
  }
  if (res.status === 401 || res.status === 403) {
    const message = res.status === 401 ? "AUTH_REQUIRED" : "ORG_REQUIRED";
    ctx.onAbort(message);
    return;
  }
  if (!res.ok) {
    throw new Error(`${label} fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as T;
  if (!ctx.aborted) {
    onSuccess(data);
  }
}

export function useAnalytics(): UseAnalyticsReturn {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const activeOrgId = activeOrg?.id ?? null;

  const range = useAtomValue(analyticsRangeAtom);
  const statusFilter = useAtomValue(analyticsStatusFilterAtom);
  const sourceFilter = useAtomValue(analyticsSourceFilterAtom);
  const projectId = useAtomValue(analyticsProjectIdAtom);
  const [loading, setLoading] = useAtom(analyticsLoadingAtom);
  const [error, setError] = useAtom(analyticsErrorAtom);

  const setSummary = useSetAtom(analyticsSummaryAtom);
  const setTimeSeries = useSetAtom(analyticsTimeSeriesAtom);
  const setNetworks = useSetAtom(analyticsNetworksAtom);
  const setRuns = useSetAtom(analyticsRunsAtom);
  const setLastUpdated = useSetAtom(analyticsLastUpdatedAtom);

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (): Promise<void> => {
    if (!activeOrgId) {
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    const baseQuery = buildQuery({ range, projectId: projectId ?? undefined });
    const runsQuery = buildQuery({
      range,
      status: statusFilter,
      source: sourceFilter,
      projectId: projectId ?? undefined,
    });

    const { signal } = controller;

    // Fire all fetches in parallel
    const summaryPromise = fetch(`/api/analytics/summary?${baseQuery}`, {
      signal,
    });
    const timeSeriesPromise = fetch(`/api/analytics/time-series?${baseQuery}`, {
      signal,
    });
    const networksPromise = fetch(`/api/analytics/networks?${baseQuery}`, {
      signal,
    });
    const runsPromise = fetch(`/api/analytics/runs?${runsQuery}`, { signal });

    let pendingCount = 4;
    const ctx: FetchContext = {
      aborted: false,
      onAbort: (message: string): void => {
        ctx.aborted = true;
        setError(message);
        setLoading(false);
        clearInterval(pollIntervalRef.current ?? undefined);
        pollIntervalRef.current = null;
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
      },
      onError: (message: string): void => {
        if (!ctx.aborted) {
          setError(message);
        }
      },
    };

    const onSectionDone = (): void => {
      pendingCount -= 1;
      if (pendingCount === 0) {
        setLoading(false);
      }
    };

    const wrapSection = async (task: Promise<void>): Promise<void> => {
      try {
        await task;
      } catch (err: unknown) {
        if (signal.aborted) {
          return;
        }
        ctx.onError(toErrorMessage(err));
      } finally {
        if (!signal.aborted) {
          onSectionDone();
        }
      }
    };

    // Process each fetch independently so atoms update as data arrives
    await Promise.all([
      wrapSection(
        processSection<AnalyticsSummary>(
          summaryPromise,
          "Summary",
          ctx,
          (data) => {
            setSummary(data);
            setLastUpdated(new Date());
          }
        )
      ),
      wrapSection(
        processSection<{ buckets: TimeSeriesBucket[] }>(
          timeSeriesPromise,
          "Time series",
          ctx,
          (data) => {
            setTimeSeries(data.buckets);
          }
        )
      ),
      wrapSection(
        processSection<{ networks: NetworkBreakdown[] }>(
          networksPromise,
          "Networks",
          ctx,
          (data) => {
            setNetworks(data.networks);
          }
        )
      ),
      wrapSection(
        processSection<RunsResponse>(runsPromise, "Runs", ctx, (data) => {
          setRuns(data);
        })
      ),
    ]);
  }, [
    activeOrgId,
    range,
    statusFilter,
    sourceFilter,
    projectId,
    setLoading,
    setError,
    setSummary,
    setTimeSeries,
    setNetworks,
    setRuns,
    setLastUpdated,
  ]);

  const cleanupSSE = useCallback((): void => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const cleanupPolling = useCallback((): void => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback((): void => {
    cleanupPolling();
    pollIntervalRef.current = setInterval(() => {
      fetchData().catch(() => {
        /* polling errors handled in fetchData */
      });
    }, POLL_INTERVAL_MS);
  }, [cleanupPolling, fetchData]);

  const startSSE = useCallback((): void => {
    cleanupSSE();

    const query = buildQuery({ range, projectId: projectId ?? undefined });
    const source = new EventSource(`/api/analytics/stream?${query}`);

    source.onmessage = (event: MessageEvent): void => {
      try {
        const parsed = JSON.parse(event.data as string) as {
          type: string;
          data: unknown;
        };

        if (parsed.type === "summary") {
          setSummary(parsed.data as AnalyticsSummary);
          setLastUpdated(new Date());
        } else if (parsed.type === "new-run" || parsed.type === "run-updated") {
          fetchData().catch(() => {
            /* SSE-triggered refresh errors handled in fetchData */
          });
        }
      } catch {
        // Ignore malformed SSE messages
      }
    };

    source.onerror = (): void => {
      cleanupSSE();
      startPolling();
    };

    eventSourceRef.current = source;
  }, [
    range,
    projectId,
    cleanupSSE,
    setSummary,
    setLastUpdated,
    startPolling,
    fetchData,
  ]);

  // Fetch on mount and when range/filters change
  useEffect(() => {
    fetchData().catch(() => {
      /* initial fetch errors handled in fetchData */
    });

    return (): void => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [fetchData]);

  // Re-fetch when org switches
  const prevOrgIdRef = useRef(activeOrgId);
  useEffect(() => {
    if (prevOrgIdRef.current === activeOrgId) {
      return;
    }
    prevOrgIdRef.current = activeOrgId;
    fetchData().catch(() => {
      /* org-switch refetch errors handled in fetchData */
    });
  }, [activeOrgId, fetchData]);

  // SSE for real-time updates, falls back to polling on error
  useEffect(() => {
    startSSE();

    return (): void => {
      cleanupSSE();
      cleanupPolling();
    };
  }, [startSSE, cleanupSSE, cleanupPolling]);

  return { loading, error, refetch: fetchData };
}
