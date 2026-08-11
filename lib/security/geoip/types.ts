/**
 * Shared types and parse helpers for the IP-to-location strategy chain.
 *
 * Every provider in `providers.ts` normalizes its vendor-specific JSON
 * down to a single `ResolvedLocation` so the resolver and its callers
 * (login-risk, the active-sessions panel, the org-admin sessions view)
 * never have to know which vendor answered. `latitude`/`longitude` are
 * the inputs to impossible-travel velocity detection; the string fields
 * drive the human-readable location label.
 */

export type ResolvedLocation = {
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
};

export const NULL_LOCATION: ResolvedLocation = {
  country: null,
  region: null,
  city: null,
  latitude: null,
  longitude: null,
};

/**
 * A single IP-to-location backend. The resolver tries configured
 * providers in order and stops at the first that yields a usable result
 * (see `isUsableLocation`), so each provider only has to translate its
 * own response shape and fail soft to null on anything it can't parse.
 *
 * `isConfigured` lets keyed providers (ipinfo) opt out when their token
 * is absent, which is the whole point of the fallback chain: with zero
 * credentials the no-key providers still answer.
 */
export type GeoIpProvider = {
  readonly name: string;
  isConfigured(): boolean;
  lookup(ip: string, signal: AbortSignal): Promise<ResolvedLocation | null>;
};

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

export function pickString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** ISO 3166-1 alpha-2, uppercased; anything else (incl. CF's XX/T1) -> null. */
export function parseCountryCode(value: unknown): string | null {
  const code = pickString(value)?.toUpperCase() ?? null;
  return code && COUNTRY_CODE_RE.test(code) ? code : null;
}

function parseCoord(value: unknown, limit: number): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number.parseFloat(value);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < -limit || n > limit) {
    return null;
  }
  return n;
}

/**
 * Validates a lat/lon pair as a unit. Exact (0, 0) is "null island" —
 * the default many geo APIs emit when they actually have no fix — so we
 * drop it rather than let impossible-travel treat the equator/prime-
 * meridian intersection as a real location. A genuine 0 on one axis with
 * a real value on the other is kept.
 */
export function parseLatLon(
  latValue: unknown,
  lonValue: unknown
): { latitude: number | null; longitude: number | null } {
  const latitude = parseCoord(latValue, 90);
  const longitude = parseCoord(lonValue, 180);
  if (latitude === null || longitude === null) {
    return { latitude: null, longitude: null };
  }
  if (latitude === 0 && longitude === 0) {
    return { latitude: null, longitude: null };
  }
  return { latitude, longitude };
}

/**
 * A result is worth keeping (and stops the fallback chain) once it has a
 * country code. Region/city/coords are enrichment; a provider that
 * resolves the country but not the city is still more useful than
 * falling through to the next vendor and burning another round-trip.
 */
export function isUsableLocation(location: ResolvedLocation): boolean {
  return location.country !== null;
}
