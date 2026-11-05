import type { RunsResponse, UnifiedRun } from "./types";

/**
 * A run as it arrives over the wire. The analytics page polls every 10s and an
 * open tab outlives a deploy, so a response can come from a server older than
 * the bundle reading it and omit array fields this client now indexes into.
 * They are optional here and filled by `normalizeRunsResponse` so a missing one
 * renders as empty instead of throwing mid-render.
 */
type ArrayFields = "networks" | "gasNetworks" | "transactionHashes";
type WireRun = Omit<UnifiedRun, ArrayFields> &
  Partial<Pick<UnifiedRun, ArrayFields>>;

export type WireRunsResponse = Omit<RunsResponse, "runs"> & {
  runs?: WireRun[];
};

export function normalizeRunsResponse(
  response: WireRunsResponse
): RunsResponse {
  return {
    ...response,
    runs: (response.runs ?? []).map((run) => ({
      ...run,
      networks: run.networks ?? [],
      gasNetworks: run.gasNetworks ?? [],
      transactionHashes: run.transactionHashes ?? [],
    })),
  };
}
