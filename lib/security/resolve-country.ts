/**
 * IP-to-location resolver. Cloudflare's `CF-IPCountry` only gives a
 * 2-letter ISO code; the active-sessions panel wants a richer
 * "Buenos Aires, BA, AR" style string so users can recognise where
 * each session signed in from at a glance, and impossible-travel
 * detection needs coordinates CF never provides. CF still wins for the
 * country when it's present (cheap, attested at the edge); this resolver
 * fills in for local-dev, tunnel, and XX/T1 cases AND enriches every
 * result with region, city, and lat/lon.
 *
 * Resolution is a fallback chain of pluggable providers (see
 * `./geoip/providers.ts`): the first configured provider that returns a
 * country wins, the rest are skipped. With no credentials the keyless
 * providers (ipapi.co, ipwho.is, freeipapi) still answer, so a missing
 * IPINFO_TOKEN / IPAPI_KEY degrades quota, not availability.
 *
 * Because those providers need no credential, a deployment that configures
 * nothing still sends every user's IP to them. Set GEOIP_ENABLED=false to stop
 * that; every caller then sees NULL_LOCATION and simply shows no location.
 *
 * Results are kept in a 24h in-memory cache keyed on IP, since session
 * creation only needs the resolve once and IPs don't change location.
 * Concurrent lookups for the same IP coalesce onto one chain walk.
 */

import { GEOIP_PROVIDERS } from "./geoip/providers";
import {
  isUsableLocation,
  NULL_LOCATION,
  type ResolvedLocation,
} from "./geoip/types";

export type { ResolvedLocation } from "./geoip/types";

const CACHE = new Map<
  string,
  { location: ResolvedLocation; expiresAt: number }
>();
// In-flight requests are tracked separately so two concurrent
// resolveLocationFromIp calls for the same IP coalesce onto one chain
// walk instead of double-charging each provider's rate limit.
const IN_FLIGHT = new Map<string, Promise<ResolvedLocation>>();
const TTL_MS = 24 * 60 * 60 * 1000;
// +/- 10% jitter on every cache write so a burst of distinct IPs
// resolved in the same minute doesn't all expire together a day
// later and trigger a thundering-herd refetch. RandomInt-like with
// Math.random is fine here: the goal is decorrelation, not
// cryptographic unpredictability.
const TTL_JITTER_MS = 0.1 * TTL_MS;
// Per-provider timeout. Kept tight because providers run in series and
// the lookup sits on the sign-in critical path; the common case is the
// first provider answering in a few hundred ms.
const PROVIDER_TIMEOUT_MS = 1500;
// Hard ceiling across the whole chain. Once exceeded we stop trying
// further providers and return whatever we have, so a run of slow/dead
// providers can't stack their timeouts onto the sign-in latency.
const CHAIN_BUDGET_MS = 3000;

function nextExpiry(): number {
  return (
    Date.now() + TTL_MS + Math.floor((Math.random() * 2 - 1) * TTL_JITTER_MS)
  );
}

/**
 * Walks the configured provider chain in order, returning the first
 * usable location (one with a country). Providers that aren't configured
 * are skipped without a round-trip; each that runs gets its own abort
 * timeout, and the whole walk is bounded by CHAIN_BUDGET_MS.
 */
async function resolveViaChain(ip: string): Promise<ResolvedLocation> {
  const startedAt = Date.now();
  for (const provider of GEOIP_PROVIDERS) {
    if (!provider.isConfigured()) {
      continue;
    }
    if (Date.now() - startedAt >= CHAIN_BUDGET_MS) {
      break;
    }
    let location: ResolvedLocation | null = null;
    try {
      location = await provider.lookup(
        ip,
        AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
      );
    } catch {
      // A provider that throws past its own guard is treated as a miss.
      location = null;
    }
    if (location && isUsableLocation(location)) {
      return location;
    }
  }
  return NULL_LOCATION;
}

// start custom keeperhub code //
/**
 * Whether to resolve locations at all.
 *
 * Every provider in the chain is a third-party service, and the keyless ones
 * answer without any credential, so a deployment that configures nothing still
 * sends each signing-in user's IP address to ipapi.co, then ipwho.is, then
 * freeipapi.com. A deployment that does not want that had no way to stop it.
 *
 * The polarity is deliberately the opposite of the NEXT_PUBLIC_*_ENABLED flags
 * elsewhere. Those default off and read `=== "true"`; this one must default on
 * so that leaving it unset reproduces today's behaviour exactly.
 *
 * Read per call rather than at module load so it can be flipped without a
 * restart, and checked before the cache so a flip takes effect at once.
 */
function geoIpEnabled(): boolean {
  return process.env.GEOIP_ENABLED !== "false";
}
// end keeperhub code //

export async function resolveLocationFromIp(
  ip: string | null
): Promise<ResolvedLocation> {
  // start custom keeperhub code //
  if (!geoIpEnabled()) {
    return NULL_LOCATION;
  }
  // end keeperhub code //
  if (!ip) {
    return NULL_LOCATION;
  }
  const cached = CACHE.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.location;
  }
  const inFlight = IN_FLIGHT.get(ip);
  if (inFlight) {
    return await inFlight;
  }
  const promise = resolveViaChain(ip).then((location) => {
    CACHE.set(ip, { location, expiresAt: nextExpiry() });
    IN_FLIGHT.delete(ip);
    return location;
  });
  IN_FLIGHT.set(ip, promise);
  return await promise;
}

/**
 * Compact display string. `"San Francisco, CA, US"` for a fully-
 * resolved row, `"AR"` when only the country code is known,
 * `null` when nothing at all was resolved.
 */
export function formatLocation(location: ResolvedLocation): string | null {
  const parts = [location.city, location.region, location.country].filter(
    (p): p is string => p !== null && p.length > 0
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.join(", ");
}
