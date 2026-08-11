import { atom } from "jotai";
import type {
  AnalyticsSummary,
  NetworkBreakdown,
  NormalizedStatus,
  RunSource,
  RunsResponse,
  TimeRange,
  TimeSeriesBucket,
} from "@/lib/analytics/types";

export const analyticsRangeAtom = atom<TimeRange>("24h");

export const analyticsCustomStartAtom = atom<string | null>(null);
export const analyticsCustomEndAtom = atom<string | null>(null);

export const analyticsSummaryAtom = atom<AnalyticsSummary | null>(null);
export const analyticsTimeSeriesAtom = atom<TimeSeriesBucket[]>([]);
export const analyticsNetworksAtom = atom<NetworkBreakdown[]>([]);
export const analyticsRunsAtom = atom<RunsResponse | null>(null);

export const analyticsLoadingAtom = atom<boolean>(true);
export const analyticsErrorAtom = atom<string | null>(null);

export const analyticsStatusFilterAtom = atom<NormalizedStatus | undefined>(
  undefined
);
export const analyticsSourceFilterAtom = atom<RunSource | undefined>(undefined);

export const analyticsSearchAtom = atom("");

export const analyticsProjectIdAtom = atom<string | null>(null);

export const analyticsLastUpdatedAtom = atom<Date | null>(null);
