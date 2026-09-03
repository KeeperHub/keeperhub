"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useRef } from "react";
import { buildRunsQuery } from "@/lib/analytics/runs-query";
import type { FacetDimension, RunFacets } from "@/lib/analytics/types";
import {
  analyticsCustomEndAtom,
  analyticsCustomStartAtom,
  analyticsDurationFilterAtom,
  analyticsFacetsAtom,
  analyticsGasFiltersAtom,
  analyticsNetworkFiltersAtom,
  analyticsProjectIdAtom,
  analyticsRangeAtom,
  analyticsSearchAtom,
  analyticsSourceFiltersAtom,
  analyticsStatusFiltersAtom,
} from "@/lib/atoms/analytics";

/**
 * Loads one facet dimension on demand.
 *
 * Network and gas counts both read `workflow_execution_logs`, which is the
 * table that took prod down when the run filters walked it too eagerly. Putting
 * them on the dashboard's ten-second poll would pay that cost for every open
 * tab forever, so they are fetched when the dropdown that shows them opens, and
 * only when the window or the other filters have actually moved since.
 */
export function useLazyFacet(dimension: FacetDimension): () => void {
  const setFacets = useSetAtom(analyticsFacetsAtom);
  const range = useAtomValue(analyticsRangeAtom);
  const statuses = useAtomValue(analyticsStatusFiltersAtom);
  const sources = useAtomValue(analyticsSourceFiltersAtom);
  const networks = useAtomValue(analyticsNetworkFiltersAtom);
  const gas = useAtomValue(analyticsGasFiltersAtom);
  const duration = useAtomValue(analyticsDurationFilterAtom);
  const search = useAtomValue(analyticsSearchAtom);
  const projectId = useAtomValue(analyticsProjectIdAtom);
  const customStart = useAtomValue(analyticsCustomStartAtom);
  const customEnd = useAtomValue(analyticsCustomEndAtom);
  const lastQuery = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  return useCallback((): void => {
    // The status filter is carried, unlike the status facet's own request:
    // only the dimension being counted is lifted, and the server lifts network
    // and gas itself. Lifting status here too would label a chain with a count
    // taken across every status, which the listing contradicts the moment the
    // reader ticks it.
    const query = buildRunsQuery({
      range,
      statuses,
      sources,
      networks,
      gas,
      duration,
      search,
      projectId,
      customStart,
      customEnd,
      dimensions: [dimension],
    });
    // Opening the same dropdown twice over unchanged filters asks nothing.
    if (lastQuery.current === query) {
      return;
    }
    lastQuery.current = query;

    // One request at a time per dimension: reopening after the window moved
    // must not let the older response land last and win.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    fetch(`/api/analytics/facets?${query}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<RunFacets>) : null))
      .then((data) => {
        if (!data) {
          return;
        }
        // Take this dimension's key alone. The response fills the dimensions it
        // was not asked to compute with {}, so merging the whole object would
        // blank the counts another dropdown, or the poll, had already loaded.
        setFacets((current) => ({
          statusCounts:
            dimension === "status" ? data.statusCounts : current.statusCounts,
          networkCounts:
            dimension === "network"
              ? data.networkCounts
              : current.networkCounts,
          gasCounts: dimension === "gas" ? data.gasCounts : current.gasCounts,
        }));
      })
      .catch(() => {
        // A missing count leaves the option unlabelled; the filter still works.
        // An abort is not a failure: the newer request owns `lastQuery` now.
        if (!controller.signal.aborted) {
          lastQuery.current = null;
        }
      });
  }, [
    dimension,
    range,
    statuses,
    sources,
    networks,
    gas,
    duration,
    search,
    projectId,
    customStart,
    customEnd,
    setFacets,
  ]);
}
