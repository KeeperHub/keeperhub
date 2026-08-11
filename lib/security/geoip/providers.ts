/**
 * IP-to-location provider strategies. Each entry normalizes one vendor's
 * JSON to the shared `ResolvedLocation`. The resolver in
 * `../resolve-country.ts` walks `GEOIP_PROVIDERS` in order, skipping any
 * whose `isConfigured()` is false, and stops at the first usable answer.
 *
 * Default chain (no env set): ipapi.co -> ipwho.is -> freeipapi. All
 * three are free and keyless, so the system resolves locations even with
 * zero credentials. Setting IPINFO_TOKEN promotes ipinfo.io to the front
 * as the keyed, higher-quota primary. Setting IPAPI_KEY raises ipapi.co's
 * rate limit but doesn't change ordering.
 *
 * ip-api.com is intentionally absent: its free tier is HTTP-only (HTTPS
 * 403s without a paid key), and we don't issue plaintext lookups from the
 * origin. Add it as a keyed provider if a license is purchased.
 */

import {
  type GeoIpProvider,
  parseCountryCode,
  parseLatLon,
  pickString,
  type ResolvedLocation,
} from "./types";

async function fetchJson(
  url: string,
  signal: AbortSignal
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as unknown;
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    // Network / abort / parse failures fall through to the next provider.
    return null;
  }
}

/**
 * ipapi.co — free tier ~1000 lookups/day/pod, no key. IPAPI_KEY raises
 * the quota when present. An `error: true` body (rate-limited, reserved
 * IP) is treated as a miss so the chain advances.
 */
const ipapiCoProvider: GeoIpProvider = {
  name: "ipapi.co",
  isConfigured: () => true,
  lookup: async (ip, signal) => {
    const key = process.env.IPAPI_KEY;
    const url = key
      ? `https://ipapi.co/${encodeURIComponent(ip)}/json/?key=${encodeURIComponent(key)}`
      : `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const data = await fetchJson(url, signal);
    if (!data || data.error) {
      return null;
    }
    const { latitude, longitude } = parseLatLon(data.latitude, data.longitude);
    const location: ResolvedLocation = {
      country: parseCountryCode(data.country_code),
      region: pickString(data.region_code) ?? pickString(data.region),
      city: pickString(data.city),
      latitude,
      longitude,
    };
    return location;
  },
};

/** ipwho.is — free, keyless. `success: false` marks an unusable answer. */
const ipwhoisProvider: GeoIpProvider = {
  name: "ipwho.is",
  isConfigured: () => true,
  lookup: async (ip, signal) => {
    const data = await fetchJson(
      `https://ipwho.is/${encodeURIComponent(ip)}`,
      signal
    );
    if (!data || data.success === false) {
      return null;
    }
    const { latitude, longitude } = parseLatLon(data.latitude, data.longitude);
    const location: ResolvedLocation = {
      country: parseCountryCode(data.country_code),
      region: pickString(data.region),
      city: pickString(data.city),
      latitude,
      longitude,
    };
    return location;
  },
};

/** freeipapi.com — free, keyless. Camel-cased fields. */
const freeipapiProvider: GeoIpProvider = {
  name: "freeipapi.com",
  isConfigured: () => true,
  lookup: async (ip, signal) => {
    const data = await fetchJson(
      `https://freeipapi.com/api/json/${encodeURIComponent(ip)}`,
      signal
    );
    if (!data) {
      return null;
    }
    const { latitude, longitude } = parseLatLon(data.latitude, data.longitude);
    const location: ResolvedLocation = {
      country: parseCountryCode(data.countryCode),
      region: pickString(data.regionName),
      city: pickString(data.cityName),
      latitude,
      longitude,
    };
    return location;
  },
};

function parseIpinfoLoc(value: unknown): {
  latitude: number | null;
  longitude: number | null;
} {
  const loc = pickString(value);
  if (!loc) {
    return { latitude: null, longitude: null };
  }
  const [lat, lon] = loc.split(",");
  return parseLatLon(lat, lon);
}

/**
 * ipinfo.io — keyed. Only joins the chain when IPINFO_TOKEN is set, and
 * when it is, it runs first (keyed quota beats the free tiers). Encodes
 * coordinates as a single `loc: "lat,lon"` string.
 */
const ipinfoProvider: GeoIpProvider = {
  name: "ipinfo.io",
  isConfigured: () => Boolean(process.env.IPINFO_TOKEN),
  lookup: async (ip, signal) => {
    const token = process.env.IPINFO_TOKEN;
    if (!token) {
      return null;
    }
    const data = await fetchJson(
      `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`,
      signal
    );
    if (!data || data.error) {
      return null;
    }
    const { latitude, longitude } = parseIpinfoLoc(data.loc);
    const location: ResolvedLocation = {
      country: parseCountryCode(data.country),
      region: pickString(data.region),
      city: pickString(data.city),
      latitude,
      longitude,
    };
    return location;
  },
};

/**
 * Resolution order. ipinfo first so a configured token wins; the keyless
 * trio follows as the always-available fallback. Exported so tests can
 * assert the chain and the resolver can iterate it.
 */
export const GEOIP_PROVIDERS: readonly GeoIpProvider[] = [
  ipinfoProvider,
  ipapiCoProvider,
  ipwhoisProvider,
  freeipapiProvider,
];
