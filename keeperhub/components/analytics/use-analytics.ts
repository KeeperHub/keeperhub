"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import type {
  AnalyticsSummary,
  NetworkBreakdown,
  RunsResponse,
  TimeSeriesBucket,
} from "@/keeperhub/lib/analytics/types";
import {
  analyticsErrorAtom,
  analyticsLastUpdatedAtom,
  analyticsLiveAtom,
  analyticsLoadingAtom,
  analyticsNetworksAtom,
  analyticsRangeAtom,
  analyticsRunsAtom,
  analyticsSourceFilterAtom,
  analyticsStatusFilterAtom,
  analyticsSummaryAtom,
  analyticsTimeSeriesAtom,
} from "@/keeperhub/lib/atoms/analytics";

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

function validateResponses(
  responses: [Response, Response, Response, Response]
): void {
  const authError = responses.find((r) => r.status === 401 || r.status === 403);
  if (authError) {
    throw new Error(
      authError.status === 401 ? "AUTH_REQUIRED" : "ORG_REQUIRED"
    );
  }

  const labels = ["Summary", "Time series", "Networks", "Runs"] as const;
  for (const [i, res] of responses.entries()) {
    if (!res.ok) {
      throw new Error(`${labels[i]} fetch failed: ${res.status}`);
    }
  }
}

function isAuthError(message: string): boolean {
  return message === "AUTH_REQUIRED" || message === "ORG_REQUIRED";
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to fetch analytics";
}

export function useAnalytics(): UseAnalyticsReturn {
  const range = useAtomValue(analyticsRangeAtom);
  const statusFilter = useAtomValue(analyticsStatusFilterAtom);
  const sourceFilter = useAtomValue(analyticsSourceFilterAtom);
  const [live, setLive] = useAtom(analyticsLiveAtom);
  const [loading, setLoading] = useAtom(analyticsLoadingAtom);
  const [error, setError] = useAtom(analyticsErrorAtom);

  const setSummary = useSetAtom(analyticsSummaryAtom);
  const setTimeSeries = useSetAtom(analyticsTimeSeriesAtom);
  const setNetworks = useSetAtom(analyticsNetworksAtom);
  const setRuns = useSetAtom(analyticsRunsAtom);
  const setLastUpdated = useSetAtom(analyticsLastUpdatedAtom);

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);

    const baseQuery = buildQuery({ range });
    const runsQuery = buildQuery({
      range,
      status: statusFilter,
      source: sourceFilter,
    });

    try {
      const [summaryRes, timeSeriesRes, networksRes, runsRes] =
        await Promise.all([
          fetch(`/api/analytics/summary?${baseQuery}`),
          fetch(`/api/analytics/time-series?${baseQuery}`),
          fetch(`/api/analytics/networks?${baseQuery}`),
          fetch(`/api/analytics/runs?${runsQuery}`),
        ]);

      validateResponses([summaryRes, timeSeriesRes, networksRes, runsRes]);

      const [summary, timeSeriesData, networksData, runs] = (await Promise.all([
        summaryRes.json(),
        timeSeriesRes.json(),
        networksRes.json(),
        runsRes.json(),
      ])) as [
        AnalyticsSummary,
        { buckets: TimeSeriesBucket[] },
        { networks: NetworkBreakdown[] },
        RunsResponse,
      ];

      setSummary(summary);
      setTimeSeries(timeSeriesData.buckets);
      setNetworks(networksData.networks);
      setRuns(runs);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      const message = toErrorMessage(err);
      setError(message);
      if (!isAuthError(message)) {
        return;
      }
      clearInterval(pollIntervalRef.current ?? undefined);
      pollIntervalRef.current = null;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    } finally {
      setLoading(false);
    }
  }, [
    range,
    statusFilter,
    sourceFilter,
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

    const query = buildQuery({ range });
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
      setLive(false);
      startPolling();
    };

    eventSourceRef.current = source;
  }, [
    range,
    cleanupSSE,
    setSummary,
    setLastUpdated,
    setLive,
    startPolling,
    fetchData,
  ]);

  // Fetch on mount and when range/filters change
  useEffect(() => {
    fetchData().catch(() => {
      /* initial fetch errors handled in fetchData */
    });
  }, [fetchData]);

  // Manage SSE / polling based on live state
  useEffect(() => {
    if (live) {
      startSSE();
    } else {
      cleanupSSE();
      startPolling();
    }

    return (): void => {
      cleanupSSE();
      cleanupPolling();
    };
  }, [live, startSSE, cleanupSSE, startPolling, cleanupPolling]);

  return { loading, error, refetch: fetchData };
}
