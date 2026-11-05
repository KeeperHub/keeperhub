import { type DurationPresetId, durationPreset } from "./duration-presets";
import type {
  FacetDimension,
  GasSpend,
  NormalizedStatus,
  RunSource,
  TimeRange,
} from "./types";

/**
 * Ceiling for `page` on the runs listing, shared by the route that enforces it
 * and the table that sizes its pager.
 *
 * getUnifiedRuns turns the page into
 * `fetchLimit = (page - 1) * pageLimit + pageLimit + 1`, and that value becomes
 * the SQL LIMIT on both source queries, so an unbounded page removes the
 * limit's effect entirely: `?page=999999999` asks Postgres for 49999999951
 * rows, which is every run in range for the organization. Both sources are
 * then concatenated and sorted in Node before an empty window is sliced out of
 * them, O(all runs) of work to return nothing.
 *
 * Its own figure rather than MAX_PAGE_SIZE from lib/pagination.ts: that
 * constant is the ceiling on a page *size*, and raising it for the list
 * endpoints it governs would move this ceiling with it, silently.
 */
export const MAX_PAGE = 200;

/** Ceiling on rows per page. The route validates against it and getUnifiedRuns applies it. */
export const MAX_RUN_LIMIT = 100;

/**
 * How many pages the pager may offer. The route clamps `page` at MAX_PAGE, so
 * a count taken from the real total alone leaves Next enabled on a page the
 * server will not advance to: it clamps back, echoes the same page, and the
 * click does nothing. Rows past `MAX_PAGE * pageSize` are then out of reach
 * from the table, which has no cursor path at all; only a caller driving the
 * API directly can pass `cursor` and read past the ceiling.
 */
export function runsPageCount(total: number, pageSize: number): number {
  if (!(Number.isFinite(total) && Number.isFinite(pageSize)) || pageSize <= 0) {
    return 1;
  }
  return Math.min(Math.max(1, Math.ceil(total / pageSize)), MAX_PAGE);
}

export type RunsQueryInput = {
  range: TimeRange;
  statuses?: NormalizedStatus[];
  sources?: RunSource[];
  networks?: string[];
  gas?: GasSpend[];
  duration?: DurationPresetId | null;
  search?: string;
  projectId?: string | null;
  /** ISO bounds, sent only for the custom range. */
  customStart?: string | null;
  customEnd?: string | null;
  page?: number;
  /** Drop the status dimension, for the facet request that counts each status. */
  omitStatus?: boolean;
  /** Which facet counts to ask for; the server defaults to status alone. */
  dimensions?: FacetDimension[];
};

/**
 * The query string for the runs listing and its facets. One builder so the
 * first page, a later page and the counts can never disagree about what is
 * being filtered.
 */
export function buildRunsQuery(input: RunsQueryInput): string {
  const params = new URLSearchParams();
  params.set("range", input.range);

  if (!input.omitStatus) {
    for (const status of input.statuses ?? []) {
      params.append("status", status);
    }
  }
  for (const source of input.sources ?? []) {
    params.append("source", source);
  }
  for (const network of input.networks ?? []) {
    params.append("network", network);
  }
  for (const value of input.gas ?? []) {
    params.append("gas", value);
  }

  const preset = durationPreset(input.duration ?? null);
  if (preset?.minMs !== undefined) {
    params.set("durationMin", String(preset.minMs));
  }
  if (preset?.maxMs !== undefined) {
    params.set("durationMax", String(preset.maxMs));
  }

  for (const dimension of input.dimensions ?? []) {
    params.append("dimension", dimension);
  }

  const search = input.search?.trim();
  if (search) {
    params.set("search", search);
  }
  if (input.projectId) {
    params.set("projectId", input.projectId);
  }
  if (input.customStart) {
    params.set("customStart", input.customStart);
  }
  if (input.customEnd) {
    params.set("customEnd", input.customEnd);
  }
  if (input.page !== undefined && input.page > 1) {
    params.set("page", String(input.page));
  }

  return params.toString();
}
