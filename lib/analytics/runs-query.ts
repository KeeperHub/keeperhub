import { type DurationPresetId, durationPreset } from "./duration-presets";
import type { GasSpend, NormalizedStatus, RunSource, TimeRange } from "./types";

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
