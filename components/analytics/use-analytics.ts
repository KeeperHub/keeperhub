"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import {
  createLeadingDebounce,
  type LeadingDebounce,
} from "@/lib/analytics/leading-debounce";
import {
  createPollScheduler,
  type PollScheduler,
} from "@/lib/analytics/poll-scheduler";
import { buildRunsQuery } from "@/lib/analytics/runs-query";
import {
  normalizeRunsResponse,
  type WireRunsResponse,
} from "@/lib/analytics/runs-response";
import { nextStreamRetry } from "@/lib/analytics/stream-retry";
import type {
  AnalyticsSummary,
  NetworkBreakdown,
  RunFacets,
  TimeSeriesBucket,
} from "@/lib/analytics/types";
import {
  analyticsCustomEndAtom,
  analyticsCustomStartAtom,
  analyticsDurationFilterAtom,
  analyticsErrorAtom,
  analyticsFacetsAtom,
  analyticsGasFiltersAtom,
  analyticsLastUpdatedAtom,
  analyticsLoadingAtom,
  analyticsNetworkFiltersAtom,
  analyticsNetworksAtom,
  analyticsProjectIdAtom,
  analyticsRangeAtom,
  analyticsRunsAtom,
  analyticsSearchAtom,
  analyticsSourceFiltersAtom,
  analyticsStatusFiltersAtom,
  analyticsSummaryAtom,
  analyticsTimeSeriesAtom,
} from "@/lib/atoms/analytics";
import { authClient } from "@/lib/auth-client";

const POLL_INTERVAL_MS = 10_000;
// A busy organization emits run events faster than a refresh completes, so the
// stream-triggered refresh is grouped into at most one pass per window.
const RUN_REFRESH_WINDOW_MS = 2000;

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
  const statusFilters = useAtomValue(analyticsStatusFiltersAtom);
  const sourceFilters = useAtomValue(analyticsSourceFiltersAtom);
  const networkFilters = useAtomValue(analyticsNetworkFiltersAtom);
  const gasFilters = useAtomValue(analyticsGasFiltersAtom);
  const durationFilter = useAtomValue(analyticsDurationFilterAtom);
  const search = useAtomValue(analyticsSearchAtom);
  const projectId = useAtomValue(analyticsProjectIdAtom);
  const customStart = useAtomValue(analyticsCustomStartAtom);
  const customEnd = useAtomValue(analyticsCustomEndAtom);
  const [loading, setLoading] = useAtom(analyticsLoadingAtom);
  const [error, setError] = useAtom(analyticsErrorAtom);

  const setSummary = useSetAtom(analyticsSummaryAtom);
  const setTimeSeries = useSetAtom(analyticsTimeSeriesAtom);
  const setNetworks = useSetAtom(analyticsNetworksAtom);
  const setRuns = useSetAtom(analyticsRunsAtom);
  const setFacets = useSetAtom(analyticsFacetsAtom);
  const setLastUpdated = useSetAtom(analyticsLastUpdatedAtom);

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollSchedulerRef = useRef<PollScheduler | null>(null);
  const runRefreshRef = useRef<LeadingDebounce | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const reconnectAttemptsRef = useRef(0);
  // startSSE reopens itself from its own onerror, which it cannot reference
  // directly inside its own useCallback.
  const startSSERef = useRef<(() => void) | null>(null);

  const fetchData = useCallback(async (): Promise<void> => {
    if (!activeOrgId) {
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    const baseQuery = buildQuery({
      range,
      projectId: projectId ?? undefined,
      customStart: customStart ?? undefined,
      customEnd: customEnd ?? undefined,
    });
    const filters = {
      range,
      statuses: statusFilters,
      sources: sourceFilters,
      networks: networkFilters,
      gas: gasFilters,
      duration: durationFilter,
      search,
      projectId,
      customStart,
      customEnd,
    };
    const runsQuery = buildRunsQuery(filters);
    // The status counts sit under every filter except status itself, so the
    // facets request carries the same query with that one dimension lifted.
    // Status only. The network and gas counts read the step logs, and this
    // request repeats every poll for every open dashboard, so they are fetched
    // when their dropdown opens instead.
    const facetsQuery = buildRunsQuery({
      ...filters,
      omitStatus: true,
      dimensions: ["status"],
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
    const facetsPromise = fetch(`/api/analytics/facets?${facetsQuery}`, {
      signal,
    });

    let pendingCount = 5;
    const ctx: FetchContext = {
      aborted: false,
      onAbort: (message: string): void => {
        ctx.aborted = true;
        setError(message);
        setLoading(false);
        pollSchedulerRef.current?.stop();
        pollSchedulerRef.current = null;
        runRefreshRef.current?.cancel();
        // An auth failure must not reopen the stream on a pending backoff.
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
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
        processSection<WireRunsResponse>(runsPromise, "Runs", ctx, (data) => {
          setRuns(normalizeRunsResponse(data));
        })
      ),
      wrapSection(
        processSection<RunFacets>(facetsPromise, "Facets", ctx, (data) => {
          // Take the status counts alone. The response still carries the other
          // two keys, empty, because they were not computed - spreading the
          // whole object would blank whichever step-log counts a dropdown had
          // already loaded, on every poll tick.
          setFacets((current) => ({
            ...current,
            statusCounts: data.statusCounts,
          }));
        })
      ),
    ]);
  }, [
    activeOrgId,
    range,
    statusFilters,
    sourceFilters,
    networkFilters,
    gasFilters,
    durationFilter,
    search,
    projectId,
    customStart,
    customEnd,
    setLoading,
    setError,
    setSummary,
    setTimeSeries,
    setNetworks,
    setRuns,
    setFacets,
    setLastUpdated,
  ]);

  const cleanupSSE = useCallback((): void => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const cleanupPolling = useCallback((): void => {
    pollSchedulerRef.current?.stop();
    pollSchedulerRef.current = null;
  }, []);

  const cleanupReconnect = useCallback((): void => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback((): void => {
    cleanupPolling();
    const scheduler = createPollScheduler(fetchData, POLL_INTERVAL_MS);
    pollSchedulerRef.current = scheduler;
    scheduler.start();
  }, [cleanupPolling, fetchData]);

  const startSSE = useCallback((): void => {
    cleanupSSE();

    runRefreshRef.current?.cancel();
    const refreshRuns = createLeadingDebounce(fetchData, RUN_REFRESH_WINDOW_MS);
    runRefreshRef.current = refreshRuns;

    const query = buildQuery({
      range,
      projectId: projectId ?? undefined,
      customStart: customStart ?? undefined,
      customEnd: customEnd ?? undefined,
    });
    const source = new EventSource(`/api/analytics/stream?${query}`);

    source.onmessage = (event: MessageEvent): void => {
      // A delivered message proves the stream is healthy, so the next close
      // starts its backoff from zero rather than from the last outage.
      reconnectAttemptsRef.current = 0;
      try {
        const parsed = JSON.parse(event.data as string) as {
          type: string;
          data: unknown;
        };

        if (parsed.type === "summary") {
          setSummary(parsed.data as AnalyticsSummary);
          setLastUpdated(new Date());
        } else if (parsed.type === "new-run" || parsed.type === "run-updated") {
          refreshRuns.call();
        }
      } catch {
        // Ignore malformed SSE messages
      }
    };

    source.onerror = (): void => {
      cleanupSSE();
      cleanupReconnect();

      // Polling is the last resort, not the response to a single close.
      const retry = nextStreamRetry(reconnectAttemptsRef.current);
      if (retry.action === "poll") {
        startPolling();
        return;
      }

      reconnectAttemptsRef.current += 1;
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        startSSERef.current?.();
      }, retry.delayMs);
    };

    eventSourceRef.current = source;
  }, [
    range,
    projectId,
    customStart,
    customEnd,
    cleanupSSE,
    cleanupReconnect,
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

  // SSE for real-time updates, reconnects on close, polls only if that fails
  useEffect(() => {
    startSSERef.current = startSSE;
    reconnectAttemptsRef.current = 0;
    startSSE();

    return (): void => {
      cleanupSSE();
      cleanupPolling();
      cleanupReconnect();
      runRefreshRef.current?.cancel();
    };
  }, [startSSE, cleanupSSE, cleanupPolling, cleanupReconnect]);

  return { loading, error, refetch: fetchData };
}
