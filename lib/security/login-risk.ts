import { and, desc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import {
  sessions,
  userTrustedCountries,
  userTrustedIps,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getRedis } from "@/lib/redis";
import { trustedCountryKey } from "@/lib/redis-keys";
import {
  CLIENT_IP_HEADERS,
  resolveIpFromHeaderValue,
} from "@/lib/security/client-ip";
import { normalizeIpForTrust } from "@/lib/security/ip-normalize";
import {
  type ResolvedLocation,
  resolveLocationFromIp,
} from "@/lib/security/resolve-country";

/**
 * Risk signal emitted by the login-time anomaly check. `anomaly: true`
 * means the application should require step-up MFA before honoring the
 * session. `reasons` is read-only diagnostic context for logging and the
 * sessions.risk_flags_json column; it never reaches the end user.
 *
 * `country` is the resolved Cloudflare-attested country for the login.
 * Null when the request did not arrive via Cloudflare (local dev, direct
 * origin access). A null country with no prior country history is treated
 * as inconclusive (anomaly = false) — we do not flag on a missing signal
 * for users who have never been placed, because doing so would trip every
 * local-dev login and self-hosted setup. But a null country for a user who
 * DOES have a country history is itself the anomaly (unknown_country): a
 * session we can no longer place is as suspicious as one from a new country.
 */
export type LoginRiskSignal = {
  anomaly: boolean;
  reasons: readonly string[];
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  recentCountries: readonly string[];
};

const RECENT_SESSION_LOOKBACK = 25;
// Impossible-travel thresholds. We only consider a hop suspicious once it
// covers real ground (city-level geo-IP jitters within a metro, so a
// sub-100km delta is noise) AND would require a speed no commercial
// itinerary sustains. 800 km/h is comfortably above airliner cruise once
// door-to-door time is included, so anything past it implies the two
// logins are not the same physical traveller.
const MIN_TRAVEL_DISTANCE_KM = 100;
const MAX_PLAUSIBLE_VELOCITY_KMH = 800;
// Floor on the elapsed time so a near-simultaneous pair of logins from
// far-apart coordinates yields a huge (correctly flagged) velocity
// instead of dividing by zero.
const MIN_ELAPSED_HOURS = 1 / 3600;
const EARTH_RADIUS_KM = 6371;

/**
 * Resolves the geographic location of the current request. CF-IPCountry
 * is authoritative at our edge and gets trusted whenever
 * CF-Connecting-IP is also present. When CF didn't attest a country
 * (no edge in the path, or it returned XX/T1), fall back to an
 * external IP-to-location lookup so the active-sessions panel still
 * shows a useful label for VPN / tunnel / local-dev sessions. The
 * fallback also enriches the response with region + city, which CF
 * never provides on its own. Cached per IP so repeated sign-ins
 * from the same address don't refetch.
 */
async function resolveLoginLocation(): Promise<ResolvedLocation> {
  let header: Awaited<ReturnType<typeof headers>>;
  try {
    header = await headers();
  } catch {
    return {
      country: null,
      region: null,
      city: null,
      latitude: null,
      longitude: null,
    };
  }
  const cfConnectingIp = header.get("cf-connecting-ip");
  const cfCountry = header.get("cf-ipcountry");
  const ip = await resolveLoginIp();
  if (cfConnectingIp && cfCountry && cfCountry !== "XX" && cfCountry !== "T1") {
    // CF gave us country at the edge. We still want region, city, and
    // coordinates (CF provides none of those) for the active-sessions
    // panel and impossible-travel detection, so layer the provider
    // chain on top and keep CF's authoritative country.
    const fallback = await resolveLocationFromIp(ip);
    return {
      country: cfCountry.toUpperCase(),
      region: fallback.region,
      city: fallback.city,
      latitude: fallback.latitude,
      longitude: fallback.longitude,
    };
  }
  return await resolveLocationFromIp(ip);
}

/**
 * Returns the distinct set of countries this user has signed in from
 * across their most recent sessions. Uses the session's own
 * `risk_flags_json` to cheaply read prior country attestations without an
 * IP-to-country lookup; sessions written before risk tracking landed
 * contribute nothing (null country) and are silently skipped.
 *
 * Returns ALL prior countries including any that match the current
 * login country — the caller does the inclusion check to decide whether
 * the current country is new vs. familiar.
 */
async function loadRecentCountries(userId: string): Promise<string[]> {
  const rows = await db
    .select({ riskFlagsJson: sessions.riskFlagsJson })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(RECENT_SESSION_LOOKBACK);
  const countries = new Set<string>();
  for (const row of rows) {
    if (!row.riskFlagsJson) {
      continue;
    }
    try {
      const parsed = JSON.parse(row.riskFlagsJson) as { country?: unknown };
      if (typeof parsed.country === "string" && parsed.country.length === 2) {
        countries.add(parsed.country.toUpperCase());
      }
    } catch {
      // Tolerate malformed rows — risk_flags_json is best-effort.
    }
  }
  return [...countries];
}

type LocatedSession = {
  latitude: number;
  longitude: number;
  createdAt: Date;
};

/**
 * Returns the most recent prior session that recorded coordinates, the
 * anchor impossible-travel measures the current login against. Reads the
 * same `risk_flags_json` blobs as loadRecentCountries; sessions minted
 * before coordinates were captured (or via paths that don't resolve
 * them) carry none and are skipped. Rows come back newest-first, so the
 * first one with valid coordinates is the freshest reference point.
 */
async function loadMostRecentLocatedSession(
  userId: string
): Promise<LocatedSession | null> {
  const rows = await db
    .select({
      riskFlagsJson: sessions.riskFlagsJson,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(RECENT_SESSION_LOOKBACK);
  for (const row of rows) {
    if (!row.riskFlagsJson) {
      continue;
    }
    try {
      const parsed = JSON.parse(row.riskFlagsJson) as {
        latitude?: unknown;
        longitude?: unknown;
      };
      if (
        typeof parsed.latitude === "number" &&
        typeof parsed.longitude === "number" &&
        Number.isFinite(parsed.latitude) &&
        Number.isFinite(parsed.longitude)
      ) {
        return {
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          createdAt: row.createdAt,
        };
      }
    } catch {
      // Tolerate malformed rows — risk_flags_json is best-effort.
    }
  }
  return null;
}

/** Great-circle distance between two coordinates, in kilometres. */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * True when reaching `current` from `prior` in the elapsed wall-clock
 * time would require a physically implausible speed. Short hops (within
 * MIN_TRAVEL_DISTANCE_KM) are ignored so city-level geo-IP jitter doesn't
 * masquerade as travel. `nowMs` is the current login's timestamp; the
 * elapsed time is floored so a near-instant teleport divides cleanly.
 */
function isImpossibleTravel(
  prior: LocatedSession,
  currentLat: number,
  currentLon: number,
  nowMs: number
): boolean {
  const distanceKm = haversineKm(
    prior.latitude,
    prior.longitude,
    currentLat,
    currentLon
  );
  if (distanceKm < MIN_TRAVEL_DISTANCE_KM) {
    return false;
  }
  const elapsedHours = Math.max(
    (nowMs - prior.createdAt.getTime()) / 3_600_000,
    MIN_ELAPSED_HOURS
  );
  const velocityKmh = distanceKm / elapsedHours;
  return velocityKmh > MAX_PLAUSIBLE_VELOCITY_KMH;
}

/**
 * Computes a risk signal for the in-flight login. Called from
 * databaseHooks.session.create.before in lib/auth.ts. Pure read; never
 * writes. Callers persist the result into sessions.risk_flags_json and
 * decide whether to flip sessions.requires_mfa based on the user's TOTP
 * enrollment state.
 *
 * Two independent signals are merged into one `anomaly`:
 *  - Country: empty history -> first_geo_attestation; known country ->
 *    clean; unseen country -> new_country anomaly; no country attested but
 *    a country history exists -> unknown_country anomaly (a login we can no
 *    longer place, treated the same as a change to a new country).
 *  - Impossible travel: when the current login carries coordinates and a
 *    prior located session exists, an implausible velocity between them
 *    flags impossible_travel — even when the country is familiar, which
 *    is the same-country-different-city gap country-only detection misses.
 */
export async function assessLoginRisk(
  userId: string
): Promise<LoginRiskSignal> {
  const location = await resolveLoginLocation();
  const { country, region, city, latitude, longitude } = location;
  const priorCountries = await loadRecentCountries(userId);
  const reasons: string[] = [];
  let anomaly = false;
  let recentCountries: string[] = [];

  if (country) {
    if (priorCountries.length === 0) {
      reasons.push("first_geo_attestation");
    } else if (priorCountries.includes(country)) {
      recentCountries = priorCountries.filter((c) => c !== country);
    } else {
      anomaly = true;
      reasons.push("new_country");
      recentCountries = priorCountries;
    }
  } else if (priorCountries.length > 0) {
    // No country attested for this login, but the user has an established
    // country history. Falling off the map is as suspicious as moving to a
    // new one, so flag it. With no prior history (local dev, self-hosted,
    // first login) a missing country stays inconclusive and never flags.
    anomaly = true;
    reasons.push("unknown_country");
    recentCountries = priorCountries;
  }

  // Impossible-travel runs regardless of the country verdict so a
  // same-country hop (familiar country, distant city) is still caught.
  // Needs coordinates on both ends; absent either, we stay silent rather
  // than flag on a missing signal — the same philosophy as the country
  // check skipping null attestations.
  if (latitude !== null && longitude !== null) {
    const prior = await loadMostRecentLocatedSession(userId);
    if (prior && isImpossibleTravel(prior, latitude, longitude, Date.now())) {
      anomaly = true;
      reasons.push("impossible_travel");
    }
  }

  return {
    anomaly,
    reasons,
    country,
    region,
    city,
    latitude,
    longitude,
    recentCountries,
  };
}

/**
 * Serializes a risk signal for storage in sessions.risk_flags_json.
 * Kept stable so prior-session lookups can decode older rows. The
 * `region`/`city` and later `latitude`/`longitude` fields were added
 * over time; absence on a stored blob is treated as null by callers, so
 * older rows decode cleanly and contribute no coordinate anchor.
 */
export function serializeRiskFlags(signal: LoginRiskSignal): string {
  return JSON.stringify({
    anomaly: signal.anomaly,
    reasons: signal.reasons,
    country: signal.country,
    region: signal.region,
    city: signal.city,
    latitude: signal.latitude,
    longitude: signal.longitude,
    recentCountries: signal.recentCountries,
  });
}

/**
 * Builds a sessions.risk_flags_json blob for a session that wasn't
 * minted through the session.create.before path (the /verify-ip
 * Drizzle insert is the only such caller today). Resolves the
 * geographic location for the IP via the shared IP-to-location
 * provider abstraction and serializes via the same
 * `serializeRiskFlags` shape Better Auth's adapter writes, so
 * downstream readers (the active-sessions panel, future audit
 * tooling) don't have to special-case the source of the row.
 *
 * `attestedCountry` is an optional override for the country field —
 * pass the CF-attested code captured at strict-signin time when
 * available, otherwise the resolver fills it from the lookup.
 */
export async function buildRiskFlagsJsonForIp(
  ip: string | null,
  attestedCountry: string | null = null
): Promise<string> {
  const location = await resolveLocationFromIp(ip);
  return serializeRiskFlags({
    anomaly: false,
    reasons: [],
    country: attestedCountry ?? location.country,
    region: location.region,
    city: location.city,
    latitude: location.latitude,
    longitude: location.longitude,
    recentCountries: [],
  });
}

/**
 * CF-attested country for the current request, or null when the request
 * did not arrive via Cloudflare (local dev, direct origin). Shared by the
 * sign-in trust check and the per-request gate so both decide trust on the
 * same authoritative signal rather than diverging (header vs provider
 * fallback). XX / T1 are CF's "unknown" sentinels and read as null.
 *
 * `cf-ipcountry` is only honored when `cf-connecting-ip` is also present:
 * both are set by Cloudflare at the edge and stripped from client input, so
 * requiring the pair means a request that reaches the origin directly (or
 * injects `cf-ipcountry`) cannot forge a specific trusted country. A forged
 * header without the CF-set connecting IP reads as null and falls through to
 * the no-country pass, never a spoofed trusted country. Mirrors the same
 * paired check in resolveLoginLocation.
 */
export async function resolveCfCountry(): Promise<string | null> {
  try {
    const header = await headers();
    const cfConnectingIp = header.get("cf-connecting-ip");
    const cf = header.get("cf-ipcountry");
    if (!cfConnectingIp) {
      return null;
    }
    return cf && cf !== "XX" && cf !== "T1" ? cf.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Structured trace for the IP-verification gate. Logs the raw
 * (pre-normalization) client IP alongside the normalized /24-or-/64
 * trust key at every stage so a rotating egress IP -- the failure mode
 * where a user gets the new-network modal but the codes never line up
 * -- is greppable end to end via `[ip-verify]`.
 */
export function logIpVerify(
  stage: string,
  fields: Record<string, unknown>
): void {
  console.info(`[ip-verify] ${stage}`, fields);
}

/**
 * Resolve the raw client IP from a set of request headers using the
 * auth system's trust model. Behind the edge proxy (staging/prod) only
 * CF-Connecting-IP is authoritative: it is set at the edge and cannot be
 * forged by the caller, whereas X-Forwarded-For and X-Real-IP are
 * caller-controlled and may be rewritten by intermediate hops, so they
 * are not a reliable source of the client IP. Outside production we fall
 * back to the first X-Forwarded-For hop and then X-Real-IP so VPN / NAT
 * changes during local dev still exercise the new-IP gate. Returns null
 * when no trusted source is present rather than an unreliable address, so
 * callers persist an honest empty value instead of a misattributed one.
 *
 * Shared by resolveLoginIp (ambient headers) and the session-minting
 * routes that write sessions.ip_address directly instead of through
 * Better Auth's getIp, so every entrypoint resolves the client IP the
 * same way.
 *
 * start custom keeperhub code //
 * CF-Connecting-IP is the default rather than the only option. A deployment
 * KeeperHub does not run sets CLIENT_IP_HEADERS to name the header its own
 * proxy sets; unset, this behaves exactly as described above.
 * end keeperhub code //
 */
export function resolveClientIpFromHeaders(
  header: Pick<Headers, "get">
): string | null {
  // start custom keeperhub code //
  // Which headers count as authoritative comes from CLIENT_IP_HEADERS, which is
  // exactly ["cf-connecting-ip"] unless a deployment sets it. A deployment that
  // KeeperHub does not run has no Cloudflare, so without the seam this returns
  // null in production and every session it mints records no address at all.
  // lib/auth.ts reads the same list, and resolveIpFromHeaderValue applies the
  // same single-hop rule better-auth applies, so both routes into
  // sessions.ip_address agree. Without that rule this side would accept a
  // caller-supplied leading hop that better-auth rejects, and the value would
  // reach both the session row and the per-IP rate-limit buckets keyed on it.
  // See lib/security/client-ip.ts.
  for (const name of CLIENT_IP_HEADERS) {
    const raw = header.get(name);
    if (!raw) {
      continue;
    }
    const trusted = resolveIpFromHeaderValue(raw);
    if (trusted) {
      return trusted;
    }
  }
  // end keeperhub code //
  if (process.env.NODE_ENV !== "production") {
    const xffFirst = header.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (xffFirst) {
      return xffFirst;
    }
    const xRealIp = header.get("x-real-ip");
    if (xRealIp) {
      return xRealIp;
    }
  }
  return null;
}

async function resolveLoginIp(): Promise<string | null> {
  try {
    return resolveClientIpFromHeaders(await headers());
  } catch {
    return null;
  }
}

/**
 * Per-request gate result. `trusted` means the current request's CF country
 * is in the user's `user_trusted_countries` list. `untrusted` carries that
 * country plus the full client IP so the caller can build the
 * pending_ip_verify cookie without re-resolving the headers. `no_country`
 * means CF did not attest a country (local dev, direct origin) -- the gate
 * passes through, fail-open, like the no_cf path at sign-in.
 */
export type RequestCountryGate =
  | { kind: "trusted" }
  | { kind: "untrusted"; country: string; ip: string | null }
  | { kind: "no_country" };

/**
 * Shared (cross-replica) cache of trusted (user, country) pairs in Redis,
 * fronting the user_trusted_countries table. A single page navigation fans
 * out into ~20 parallel gate checks; the cache collapses those to one DB read
 * per (user, country) per TTL window across the whole fleet, instead of one
 * per pod.
 *
 * Postgres stays the durable source of truth: on a cache miss the gate reads
 * the DB and re-populates Redis, so a Redis flush or restart re-fills on
 * demand and never locks anyone out. Only `trusted` is cached -- untrusted is
 * always re-checked against the DB. Trust is monotonic, so a cached entry is
 * never a false positive; the TTL just bounds memory and any future
 * revocation window.
 */
const TRUSTED_TTL_SECONDS = 300;

/**
 * Mark (user, country) trusted in the shared cache. Called by the gate after a
 * DB hit and by /api/user/verify-ip after a successful upsert, so every
 * replica's next request is a cache hit. Best-effort: a missing or failing
 * Redis is swallowed (the DB read-through still serves the correct answer).
 */
export async function cacheTrustedCountry(
  userId: string,
  country: string
): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    return;
  }
  try {
    await redis.set(
      trustedCountryKey(userId, country),
      "1",
      "EX",
      TRUSTED_TTL_SECONDS
    );
  } catch {
    // best-effort cache write; the DB remains the source of truth
  }
}

/**
 * Transition bridge: true when the current request's IP is in the legacy
 * user_trusted_ips list. Before country trust shipped, every active session
 * had its source IP recorded here; reading it lets an already-trusted user
 * pass the new country gate without a /verify-ip detour, and the caller then
 * backfills the country so the bridge is only consulted until the country is
 * recorded. The IP comparison normalizes both sides to the /24-or-/64
 * network, matching how the rows were written.
 */
async function legacyIpTrusted(
  userId: string,
  rawIp: string | null
): Promise<boolean> {
  if (!rawIp) {
    return false;
  }
  const ip = normalizeIpForTrust(rawIp);
  const [hit] = await db
    .select({ id: userTrustedIps.id })
    .from(userTrustedIps)
    .where(and(eq(userTrustedIps.userId, userId), eq(userTrustedIps.ip, ip)))
    .limit(1);
  return Boolean(hit);
}

/**
 * Per-request country gate consulted by the root proxy on every authenticated
 * request. Resolves the CF-attested country from the cheap edge header (no
 * external IP-to-location lookup on the hot path). When CF didn't attest a
 * country we return `no_country` and pass through, mirroring the no_cf
 * fail-open at sign-in. The full client IP is resolved only for the
 * pending-cookie payload on the untrusted path.
 *
 * On a country miss the legacy IP bridge is consulted: a session whose IP is
 * already in user_trusted_ips passes, and the country is backfilled into
 * user_trusted_countries so the transition is seamless for users who were
 * signed in before this shipped. That backfill is the gate's only write.
 */
export async function gateRequestCountry(
  userId: string
): Promise<RequestCountryGate> {
  const country = await resolveCfCountry();
  if (!country) {
    return { kind: "no_country" };
  }

  // Fast path: shared Redis cache. A hit means a prior DB read on some replica
  // already confirmed trust; trust is monotonic so the cached answer is safe.
  const redis = getRedis();
  if (redis) {
    try {
      if ((await redis.get(trustedCountryKey(userId, country))) === "1") {
        return { kind: "trusted" };
      }
    } catch {
      // Redis unavailable -- fall through to the DB source of truth.
    }
  }

  // Source of truth: user_trusted_countries. Re-populate the cache on a hit so
  // the next request on any replica is served from Redis.
  const [hit] = await db
    .select({ id: userTrustedCountries.id })
    .from(userTrustedCountries)
    .where(
      and(
        eq(userTrustedCountries.userId, userId),
        eq(userTrustedCountries.country, country)
      )
    )
    .limit(1);
  if (hit) {
    cacheTrustedCountry(userId, country).catch(() => {
      // cacheTrustedCountry already swallows; floating-promise boundary
    });
    return { kind: "trusted" };
  }

  const ip = await resolveLoginIp();

  // Legacy bridge: an already-trusted IP from before country trust shipped
  // passes the gate. Backfill the country so subsequent requests are a fast
  // user_trusted_countries hit and the bridge fades on its own.
  if (await legacyIpTrusted(userId, ip)) {
    await upsertTrustedCountry(userId, country);
    cacheTrustedCountry(userId, country).catch(() => {
      // best-effort cache warm; the upsert above is durable
    });
    logIpVerify("gate-bridge-legacy-ip", { userId, country, ip });
    return { kind: "trusted" };
  }

  logIpVerify("gate-untrusted-country", { userId, country, ip });
  return { kind: "untrusted", country, ip };
}

/**
 * Trust decision for the in-flight session's country. Called from
 * databaseHooks.session.create.before and the strict-signin route.
 *
 *   - country null (no CF attestation) -> trusted, reason "no_cf". Avoids
 *     locking out local-dev and self-hosted setups.
 *   - country in user_trusted_countries -> trusted, reason "known".
 *   - first attestation (user has zero trusted countries) -> trusted,
 *     reason "first". Mirrors the IP feature's migration stance: a brand
 *     new user, and every existing user's first post-deploy login,
 *     auto-trusts the country they happen to be on; /verify-ip kicks in only
 *     for SUBSEQUENT new countries.
 *   - legacy IP bridge -> trusted, reason "legacy_ip". The country is unknown
 *     but the IP is already in user_trusted_ips from before country trust
 *     shipped, so the user is not bounced; the caller records the country.
 *   - otherwise -> untrusted. Caller defers the session to /verify-ip.
 *
 * `ip` is the full (un-normalized) client IP, carried into the pending
 * cookie + session row by the caller.
 */
export type CountryTrust = {
  country: string | null;
  ip: string | null;
  trusted: boolean;
  reason: "no_cf" | "known" | "first" | "legacy_ip" | "untrusted";
};

export async function assessCountryTrust(
  userId: string
): Promise<CountryTrust> {
  const ip = await resolveLoginIp();
  const country = await resolveCfCountry();
  if (!country) {
    logIpVerify("assess-country", { userId, country: null, reason: "no_cf" });
    return { country: null, ip, trusted: true, reason: "no_cf" };
  }

  const [hit] = await db
    .select({ id: userTrustedCountries.id })
    .from(userTrustedCountries)
    .where(
      and(
        eq(userTrustedCountries.userId, userId),
        eq(userTrustedCountries.country, country)
      )
    )
    .limit(1);
  if (hit) {
    logIpVerify("assess-country", { userId, country, reason: "known" });
    return { country, ip, trusted: true, reason: "known" };
  }

  const [anyTrusted] = await db
    .select({ id: userTrustedCountries.id })
    .from(userTrustedCountries)
    .where(eq(userTrustedCountries.userId, userId))
    .limit(1);
  if (!anyTrusted) {
    logIpVerify("assess-country", { userId, country, reason: "first" });
    return { country, ip, trusted: true, reason: "first" };
  }

  // Legacy bridge: an unfamiliar country whose IP is already trusted from
  // before country trust shipped is honored rather than bounced. The caller
  // records the country, retiring the bridge for this (user, country).
  if (await legacyIpTrusted(userId, ip)) {
    logIpVerify("assess-country", { userId, country, reason: "legacy_ip" });
    return { country, ip, trusted: true, reason: "legacy_ip" };
  }

  logIpVerify("assess-country", { userId, country, reason: "untrusted" });
  return { country, ip, trusted: false, reason: "untrusted" };
}

/**
 * Idempotently record a country in a user's trusted list. The unique
 * (user_id, country) constraint makes the upsert safe to repeat: a known
 * country just bumps last_seen_at. Best-effort by design. A failure is logged
 * and swallowed because trust-list bookkeeping must never block the sign-in
 * that triggered it. If the write is lost, the next sign-in from the same
 * country hits the /verify-ip gate, which is the correct fail-closed
 * direction.
 */
export async function upsertTrustedCountry(
  userId: string,
  country: string
): Promise<void> {
  try {
    await db
      .insert(userTrustedCountries)
      .values({ userId, country })
      .onConflictDoUpdate({
        target: [userTrustedCountries.userId, userTrustedCountries.country],
        set: { lastSeenAt: new Date() },
      });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[country-trust] failed to upsert trusted country",
      err,
      { user_id: userId, country }
    );
  }
}

/**
 * Record the current request's country as trusted for this user, mirroring
 * the databaseHooks.session.create.before path in lib/auth.ts. Called by the
 * pending-signup TOTP enroll path, which mints a user's first session by
 * inserting the row directly and so never runs that hook. Records only on a
 * positive trust decision: first-ever attestation or an already-known
 * country. An untrusted country is left for the /verify-ip gate to resolve.
 */
export async function recordTrustedCountryFromRequest(
  userId: string
): Promise<void> {
  const trust = await assessCountryTrust(userId);
  if (trust.country && trust.trusted) {
    await upsertTrustedCountry(userId, trust.country);
  }
}
