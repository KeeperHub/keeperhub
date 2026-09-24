import { atom } from "jotai";
import type { DurationPresetId } from "@/lib/analytics/duration-presets";
import type {
  AnalyticsSummary,
  GasSpend,
  NetworkBreakdown,
  NormalizedStatus,
  RunSource,
  RunsResponse,
  RunFacets,
  TimeRange,
  TimeSeriesBucket,
} from "@/lib/analytics/types";

export const analyticsRangeAtom = atom<TimeRange>("24h");

export const analyticsCustomStartAtom = atom<string | null>(null);
export const analyticsCustomEndAtom = atom<string | null>(null);

export const analyticsSummaryAtom = atom<AnalyticsSummary | null>(null);
export const analyticsTimeSeriesAtom = atom<TimeSeriesBucket[]>([]);
// Width of one chart bucket, chosen server-side from how wide the window is.
// The axis labels read from this rather than from the range name, which says
// nothing about granularity once the range is a hand-picked one.
export const analyticsTimeSeriesIntervalAtom = atom<number>(60 * 60 * 1000);
export const analyticsNetworksAtom = atom<NetworkBreakdown[]>([]);
export const analyticsRunsAtom = atom<RunsResponse | null>(null);

export const analyticsLoadingAtom = atom<boolean>(true);
export const analyticsErrorAtom = atom<string | null>(null);

// Every run filter is a set: an empty array means the dimension is not
// narrowing anything, and several values inside one dimension are a union.
export const analyticsStatusFiltersAtom = atom<NormalizedStatus[]>([]);
export const analyticsSourceFiltersAtom = atom<RunSource[]>([]);
export const analyticsNetworkFiltersAtom = atom<string[]>([]);
export const analyticsGasFiltersAtom = atom<GasSpend[]>([]);

// Duration is the one dimension where overlapping choices would be confusing,
// so it stays a single bucket.
export const analyticsDurationFilterAtom = atom<DurationPresetId | null>(null);

// Run counts per status, for the counts beside each status option.
export const analyticsFacetsAtom = atom<RunFacets>({
  statusCounts: {},
  networkCounts: {},
  gasCounts: {},
});

export const analyticsSearchAtom = atom("");

export const analyticsProjectIdAtom = atom<string | null>(null);

export const analyticsLastUpdatedAtom = atom<Date | null>(null);
