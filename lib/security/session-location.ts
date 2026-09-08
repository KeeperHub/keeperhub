/**
 * Shared decode + enrichment for the `sessions.risk_flags_json` blob.
 * Both the self-service active-sessions panel (`/api/user/sessions`) and
 * the org-admin per-member view (`/api/organizations/.../sessions`) read
 * the same column and want the same shape: a resolved location plus the
 * anomaly verdict recorded at sign-in. Keeping the decode here means the
 * two routes can't drift on how a stored blob is interpreted.
 */

import {
  formatLocation,
  type ResolvedLocation,
  resolveLocationFromIp,
} from "@/lib/security/resolve-country";

const EMPTY_LOCATION: ResolvedLocation = {
  country: null,
  region: null,
  city: null,
  latitude: null,
  longitude: null,
};

export type DecodedRiskFlags = {
  location: ResolvedLocation;
  /** Anomaly verdict the login-risk assessment recorded for this session. */
  anomaly: boolean;
  /** Diagnostic reason codes, e.g. ["new_country", "impossible_travel"]. */
  reasons: string[];
};

function pickString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickCoord(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickReasons(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((r): r is string => typeof r === "string");
}

/** Decodes a risk-flags blob into location + anomaly verdict. */
export function decodeRiskFlags(
  riskFlagsJson: string | null
): DecodedRiskFlags {
  if (!riskFlagsJson) {
    return { location: EMPTY_LOCATION, anomaly: false, reasons: [] };
  }
  try {
    const parsed = JSON.parse(riskFlagsJson) as {
      country?: unknown;
      region?: unknown;
      city?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      anomaly?: unknown;
      reasons?: unknown;
    };
    const countryRaw = pickString(parsed.country);
    return {
      location: {
        country: countryRaw ? countryRaw.toUpperCase() : null,
        region: pickString(parsed.region),
        city: pickString(parsed.city),
        latitude: pickCoord(parsed.latitude),
        longitude: pickCoord(parsed.longitude),
      },
      anomaly: parsed.anomaly === true,
      reasons: pickReasons(parsed.reasons),
    };
  } catch {
    return { location: EMPTY_LOCATION, anomaly: false, reasons: [] };
  }
}

function mergeLocations(
  primary: ResolvedLocation,
  fallback: ResolvedLocation
): ResolvedLocation {
  return {
    country: primary.country ?? fallback.country,
    region: primary.region ?? fallback.region,
    city: primary.city ?? fallback.city,
    latitude: primary.latitude ?? fallback.latitude,
    longitude: primary.longitude ?? fallback.longitude,
  };
}

/**
 * Resolves a display location for a session row. Uses the decoded blob
 * first and only falls back to a live IP lookup when the stored blob is
 * missing city/region (older rows, or rows minted by paths that skip the
 * login-risk assessment). `resolveLocationFromIp` is cached 24h per IP,
 * so repeated panel loads don't refetch.
 */
export async function locationForSessionRow(
  decoded: ResolvedLocation,
  ipAddress: string | null
): Promise<{ country: string | null; location: string | null }> {
  const needsFallback =
    (decoded.city === null || decoded.region === null) && ipAddress;
  const merged = needsFallback
    ? mergeLocations(decoded, await resolveLocationFromIp(ipAddress))
    : decoded;
  return { country: merged.country, location: formatLocation(merged) };
}

/**
 * Resolves ONLY the coarse country code for a session row, never the IP,
 * city, or coordinates. This is the deliberate floor for the org-admin
 * per-member view: an admin can see "this teammate signed in from AU" to
 * spot an unfamiliar location, but the precise IP/city stays server-side
 * and never reaches the client. The country comes from the stored
 * attestation, falling back to a cached IP lookup only when the blob
 * never recorded one; the IP itself is never returned.
 */
export async function countryForSessionRow(
  decoded: ResolvedLocation,
  ipAddress: string | null
): Promise<string | null> {
  if (decoded.country) {
    return decoded.country;
  }
  if (!ipAddress) {
    return null;
  }
  const fallback = await resolveLocationFromIp(ipAddress);
  return fallback.country;
}
