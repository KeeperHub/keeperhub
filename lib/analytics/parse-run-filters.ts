import type {
  GasSpend,
  NormalizedStatus,
  RunQueryFilters,
  RunSource,
} from "./types";

const VALID_STATUSES = new Set<NormalizedStatus>([
  "pending",
  "running",
  "success",
  "error",
  "system_error",
  "external_error",
  "skipped",
  "cancelled",
]);

const VALID_SOURCES = new Set<RunSource>(["workflow", "direct"]);

const VALID_GAS = new Set<GasSpend>(["sponsored", "wallet", "free"]);

// A search long enough to be a run id is as long as a search ever needs to be,
// and the cap keeps an ILIKE pattern from being handed an arbitrary payload.
const MAX_SEARCH_LENGTH = 128;

function parseNonNegativeInt(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/**
 * Read the run filters off a request's query string. Every dimension is
 * repeatable (`?status=error&status=system_error`), so a single value still
 * parses the way it always did.
 */
export function parseRunFilters(params: URLSearchParams): RunQueryFilters {
  const statuses = params
    .getAll("status")
    .filter((value): value is NormalizedStatus =>
      VALID_STATUSES.has(value as NormalizedStatus)
    );
  const sources = params
    .getAll("source")
    .filter((value): value is RunSource =>
      VALID_SOURCES.has(value as RunSource)
    );
  const networks = params.getAll("network").filter((value) => value.length > 0);
  const gas = params
    .getAll("gas")
    .filter((value): value is GasSpend => VALID_GAS.has(value as GasSpend));
  const search = params.get("search")?.trim().slice(0, MAX_SEARCH_LENGTH);

  return {
    ...(statuses.length > 0 ? { statuses: [...new Set(statuses)] } : {}),
    ...(sources.length > 0 ? { sources: [...new Set(sources)] } : {}),
    ...(networks.length > 0 ? { networks: [...new Set(networks)] } : {}),
    ...(gas.length > 0 ? { gas: [...new Set(gas)] } : {}),
    ...(parseNonNegativeInt(params.get("durationMin")) === undefined
      ? {}
      : { durationMinMs: parseNonNegativeInt(params.get("durationMin")) }),
    ...(parseNonNegativeInt(params.get("durationMax")) === undefined
      ? {}
      : { durationMaxMs: parseNonNegativeInt(params.get("durationMax")) }),
    ...(search ? { search } : {}),
  };
}
