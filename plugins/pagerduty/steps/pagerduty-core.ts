/**
 * Shared PagerDuty client and payload builder.
 *
 * IMPORTANT: this file must NOT contain "use step". It is imported by the
 * plugin's step files and by the picker API route, so it exports functions
 * freely; a "use step" file may not.
 *
 * Two PagerDuty APIs are in play and they are not interchangeable:
 *
 * - Events API v2 (events.pagerduty.com/v2/enqueue) takes a per-service
 *   routing key and merges repeat triggers that carry the same dedup key into
 *   the open alert. That merge behaviour is why every action here always sends
 *   a dedup key: it makes a retry, and a re-run of the same check, idempotent.
 * - The REST API (api.pagerduty.com) is used read-only, to list the account's
 *   services and escalation policies and to resolve a service's routing key.
 *   The one exception is the create-incident action, which posts an incident
 *   and is the only action needing a write-capable credential.
 *
 * Hosts are fixed per region, chosen by a checkbox on the connection. No
 * config value reaches the host, so the plugin stays `egress: "fixed-host"`
 * and a workflow can never redirect it.
 */
import { safeFetch, SsrfBlockedError } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import {
  isConnectionFailure,
  isRetryableHttpStatus,
  parseRetryAfterHeaderMs,
} from "@/lib/workflow/retry-policy";
import type { PagerDutyCredentials } from "../credentials";
import {
  cleanDisplayField,
  isEuRegionFlag,
  isHeaderSafeToken,
  stripControlChars,
  PAGERDUTY_ACCEPT_V2,
  PAGERDUTY_API_HOST,
  PAGERDUTY_API_HOST_EU,
  PAGERDUTY_EVENTS_HOST,
  PAGERDUTY_EVENTS_HOST_EU,
  PAGERDUTY_IDENTITY_TOKEN_URL,
  PAGERDUTY_OAUTH_SCOPES_MINIMAL,
  PAGERDUTY_REQUEST_TIMEOUT_MS,
  pagerDutyOAuthScope,
  type PagerDutyEventBody,
  type Trim,
  trimToLimit,
} from "../event-payload";

export {
  buildTriggerEvent,
  buildUpdateEvent,
  cleanCustomDetails,
  cleanDisplayField,
  cleanLinks,
  deriveDedupKey,
  describeTrims,
  FIELD_LIMITS,
  type Trim,
  trimToLimit,
  MAX_DEDUP_KEY_CHARS,
  MAX_EVENT_BYTES,
  MAX_SUMMARY_CHARS,
  normaliseSeverity,
  type PagerDutyEventBody,
  type PagerDutySeverity,
  pagerDutyServiceUrl,
  parseLinks,
  truncateRunes,
} from "../event-payload";

// Shared with the client-bundled connection test, so the two cannot drift.
const EVENTS_HOST = PAGERDUTY_EVENTS_HOST;
const EVENTS_HOST_EU = PAGERDUTY_EVENTS_HOST_EU;
const API_HOST = PAGERDUTY_API_HOST;
const API_HOST_EU = PAGERDUTY_API_HOST_EU;
const IDENTITY_TOKEN_URL = PAGERDUTY_IDENTITY_TOKEN_URL;

const REQUEST_TIMEOUT_MS = PAGERDUTY_REQUEST_TIMEOUT_MS;
const PLUGIN = "pagerduty";
const ACCEPT_V2 = PAGERDUTY_ACCEPT_V2;
/** Re-exported name for the pair; it lives beside the scope builder. */
const OAUTH_SCOPES_MINIMAL = PAGERDUTY_OAUTH_SCOPES_MINIMAL;

/**
 * The scopes to ask for on behalf of one call.
 *
 * A client-credentials grant is refused outright - a 400 - if it asks for a
 * scope the app registration does not hold, so the request has to match what
 * the user actually granted. Asking for a fixed superset and falling back to
 * the minimal pair looks like it handles that, and does for the two ends of
 * the range, but it silently loses everything in between: an app granted the
 * two read scopes plus incidents.read is refused the superset, falls back to
 * the pair, and the incident read-back then fails with a 403 for a scope its
 * owner did in fact grant. That is the shape the connection form recommends,
 * so it was the common case rather than the edge one.
 *
 * Asking for the pair plus whatever this particular call needs means the
 * request matches the grant for every combination somebody might reasonably
 * register.
 */
function oauthScopesFor(requiredScope: string): string {
  return OAUTH_SCOPES_MINIMAL.split(" ").includes(requiredScope)
    ? OAUTH_SCOPES_MINIMAL
    : `${OAUTH_SCOPES_MINIMAL} ${requiredScope}`;
}
/** Renew a little before expiry so a call never races the boundary. */
const OAUTH_EXPIRY_SKEW_MS = 60_000;

export type PagerDutyService = {
  id: string;
  name: string;
  escalationPolicyId?: string;
  escalationPolicyName?: string;
  /** False when the service has no Events API v2 integration to route events through. */
  acceptsEvents: boolean;
  /**
   * PagerDuty's own service status. "disabled" and "maintenance" both swallow
   * events: PagerDuty accepts them and creates no incident, which is invisible
   * from the event response.
   */
  status?: string;
  htmlUrl?: string;
};

export type PagerDutyEscalationPolicy = {
  id: string;
  name: string;
  htmlUrl?: string;
};

/**
 * An account's incident priorities (P1, P2, ...). A paid-plan feature, so an
 * account without it answers 402 or returns nothing, and only the REST
 * create-incident action can set one: the Events API v2 payload has no
 * priority field, and an alert-created incident takes its priority from the
 * account's Event Orchestration rules instead.
 */
export type PagerDutyPriority = {
  id: string;
  name: string;
  description?: string;
  htmlUrl?: string;
};

/**
 * Why a PagerDuty call failed, in the shape the steps and the picker route
 * both need: a message for the user, whether another attempt could help, and
 * the status for logging.
 */
export type PagerDutyFailure = {
  message: string;
  status?: number;
  retryable: boolean;
  /** Milliseconds PagerDuty asked us to wait, when it said. */
  retryAfterMs?: number;
  /**
   * Who can fix it, when the status cannot say.
   *
   * A failure with no HTTP status used to be read as a network fault, which is
   * right for a request that got no answer and wrong for every configuration
   * fault this plugin builds by hand - a deleted connection, a token pasted
   * with a line break, a service with no Events API v2 integration. Those were
   * reported as EXTERNAL, and `applyErrorClassHint` also forces the error
   * category to EXTERNAL_SERVICE, so one misconfigured node read as PagerDuty
   * having been down in the execution metrics.
   */
  fault?: "user" | "external";
};

export type PagerDutyResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: PagerDutyFailure };

/**
 * PagerDuty resource ids are short alphanumeric strings. Every id below is
 * also percent-encoded before it reaches a URL, so this is defence in depth:
 * it stops a crafted config value from being smuggled into a request path or
 * a header at all, and gives a clear error instead of a confusing 404.
 */
const PAGERDUTY_ID = /^[A-Za-z0-9_-]{2,64}$/;
export function isPagerDutyId(value: string): boolean {
  return PAGERDUTY_ID.test(value);
}

/**
 * A `From` header value PagerDuty will accept and no proxy can misread. The
 * shape check is loose on purpose - PagerDuty owns the real validation - but
 * control characters are rejected outright, because a header value carrying
 * CR or LF is a header-injection attempt, never a typo.
 */
const HEADER_SAFE_EMAIL =
  /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/;

export function isHeaderSafeEmail(value: string): boolean {
  return value.length <= 320 && HEADER_SAFE_EMAIL.test(value);
}

function invalidId(kind: string, value: string): PagerDutyFailure {
  return {
    message: `"${value}" is not a valid PagerDuty ${kind} id. Pick the ${kind} again on this node rather than typing an id by hand.`,
    retryable: false,
    fault: "user",
  };
}

/**
 * Which service region the account lives in.
 *
 * The value reaches here as a string from three places - the connection
 * checkbox, an environment variable on a self-hosted install, and an MCP
 * caller - and only the checkbox is guaranteed to write "true". Reading
 * PAGERDUTY_EU_REGION=1 as US would send every event to the wrong region and
 * fail as a 401, which looks exactly like a bad token.
 */
export function isEuRegion(credentials: PagerDutyCredentials): boolean {
  return isEuRegionFlag(credentials.PAGERDUTY_EU_REGION);
}

export function eventsUrl(
  credentials: PagerDutyCredentials,
  path: string
): string {
  return `${isEuRegion(credentials) ? EVENTS_HOST_EU : EVENTS_HOST}${path}`;
}

export function apiUrl(
  credentials: PagerDutyCredentials,
  path: string
): string {
  return `${isEuRegion(credentials) ? API_HOST_EU : API_HOST}${path}`;
}

/**
 * In-process cache of OAuth bearer tokens, keyed by client id, subdomain and
 * region. Tokens are short-lived and never persisted: a restart simply
 * re-exchanges the client credentials.
 */
const oauthTokens = new Map<
  string,
  { header: string; expiresAt: number; credentialKey: string }
>();

/**
 * How many entries either in-process cache may hold.
 *
 * Both are keyed by the credential, so every rotation mints keys that the old
 * ones can never be reached by again, and the routing key cache adds a
 * dimension per service. `expiresAt` decides whether an entry may be *used*;
 * on its own it evicts nothing, so in a worker that stays up for weeks and
 * serves every organisation the maps only ever grow. The cap is generous
 * enough that a busy process never reaches it in normal use, and losing a live
 * entry costs one REST read or one token exchange - both paths the code
 * already takes on a miss.
 */
const MAX_CACHE_ENTRIES = 500;

function pruneCache<V extends { expiresAt: number }>(
  cache: Map<string, V>
): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
  // A Map iterates in insertion order, so this drops the least recently
  // written first.
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

/** Exported for tests, which need a clean cache between cases. */
export function clearOAuthTokenCache(): void {
  oauthTokens.clear();
}

/** Exported for tests: how many entries a cache is currently holding. */
export function cacheSizesForTest(): { oauth: number; routingKeys: number } {
  return { oauth: oauthTokens.size, routingKeys: routingKeys.size };
}

/**
 * Drop a cached bearer token. Called on a 401 so a token revoked in PagerDuty
 * - the app registration deleted, its scopes narrowed, the owning user
 * deactivated - is re-exchanged on the next call instead of being retried from
 * cache until it expires on its own.
 */
function invalidateOAuthToken(credentials: PagerDutyCredentials): void {
  // Every scope set held for this credential, not just the one the failing
  // call asked for: a revoked app registration invalidates all of them, and
  // leaving the others cached would keep answering 401 until they expire.
  const credentialKey = oauthCredentialKey(credentials);
  for (const [key, entry] of oauthTokens) {
    if (entry.credentialKey === credentialKey) {
      oauthTokens.delete(key);
    }
  }
}

type OAuthTokenResponse = { access_token?: string; expires_in?: number };

/**
 * Cache key for an exchanged bearer token.
 *
 * The client secret is part of the key. Leaving it out would mean two things,
 * both bad: rotating a leaked secret would not invalidate the token issued to
 * the old one, and two connections sharing a client id and subdomain - values
 * that are not secret, the subdomain appears in every PagerDuty URL - would
 * share a cached token without either secret ever being checked.
 *
 * It goes in as itself rather than as a digest. Hashing it protected nothing:
 * every value in this map is a live `Bearer` header, so the map is
 * credential-bearing whatever the keys look like, and the credentials object
 * is in memory for the whole call regardless. A digest here only read to a
 * scanner as a password stored under a fast hash, which is not what this is.
 *
 * JSON encodes the parts so no separator can appear inside one and make two
 * different credentials collide on one key.
 */
function oauthCredentialKey(credentials: PagerDutyCredentials): string {
  return JSON.stringify([
    credentials.PAGERDUTY_OAUTH_CLIENT_ID ?? "",
    credentials.PAGERDUTY_SUBDOMAIN ?? "",
    isEuRegion(credentials) ? "eu" : "us",
    credentials.PAGERDUTY_OAUTH_CLIENT_SECRET ?? "",
  ]);
}

/** One entry per credential and scope set, since a token only carries what it asked for. */
function oauthCacheKey(
  credentials: PagerDutyCredentials,
  scopes: string
): string {
  return JSON.stringify([oauthCredentialKey(credentials), scopes]);
}

export function oauthScopeString(
  credentials: PagerDutyCredentials,
  scopes: string
): string {
  return pagerDutyOAuthScope(
    isEuRegion(credentials),
    credentials.PAGERDUTY_SUBDOMAIN ?? "",
    scopes
  );
}

async function fetchOAuthHeader(
  credentials: PagerDutyCredentials,
  scopes: string
): Promise<PagerDutyResult<string>> {
  const clientId = credentials.PAGERDUTY_OAUTH_CLIENT_ID ?? "";
  const clientSecret = credentials.PAGERDUTY_OAUTH_CLIENT_SECRET ?? "";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: oauthScopeString(credentials, scopes),
  });

  try {
    const response = await safeFetch(IDENTITY_TOKEN_URL, {
      plugin: PLUGIN,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // The app does not hold the scope this call wanted. Fall back to the pair
    // every connection is told to grant, so the reads that only need those
    // still work; the call that wanted more gets PagerDuty's 403 and a message
    // naming the scope. The result is cached under the scopes that were asked
    // for, so this costs one extra exchange per scope set, not per call.
    if (response.status === 400 && scopes !== OAUTH_SCOPES_MINIMAL) {
      const minimal = await fetchOAuthHeader(credentials, OAUTH_SCOPES_MINIMAL);
      if (minimal.ok) {
        const cached = oauthTokens.get(
          oauthCacheKey(credentials, OAUTH_SCOPES_MINIMAL)
        );
        if (cached) {
          oauthTokens.set(oauthCacheKey(credentials, scopes), cached);
        }
      }
      return minimal;
    }

    if (!response.ok) {
      return {
        ok: false,
        failure: {
          message:
            response.status === 400 || response.status === 401
              ? "PagerDuty rejected the OAuth client credentials. Check the client id, secret and subdomain, and that the app grants services.read."
              : `PagerDuty could not issue an OAuth token (HTTP ${response.status}).`,
          status: response.status,
          retryable: isRetryableHttpStatus(response.status),
        },
      };
    }

    const parsed = (await response.json()) as OAuthTokenResponse;
    if (!parsed.access_token) {
      return {
        ok: false,
        failure: {
          message: "PagerDuty returned no access token for these credentials.",
          retryable: false,
        },
      };
    }

    const header = `Bearer ${parsed.access_token}`;
    const lifetimeMs = (parsed.expires_in ?? 0) * 1000;
    if (lifetimeMs > OAUTH_EXPIRY_SKEW_MS) {
      pruneCache(oauthTokens);
      oauthTokens.set(oauthCacheKey(credentials, scopes), {
        header,
        expiresAt: Date.now() + lifetimeMs - OAUTH_EXPIRY_SKEW_MS,
        credentialKey: oauthCredentialKey(credentials),
      });
    }
    return { ok: true, value: header };
  } catch (error) {
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty to exchange the OAuth credentials: ${getErrorMessage(error)}`,
        retryable: isConnectionFailure(error),
      },
    };
  }
}

/**
 * The Authorization header for REST calls. An API token wins when both are
 * set, because it needs no round trip; otherwise the OAuth client credentials
 * are exchanged for a bearer token and cached until shortly before expiry.
 */
export async function resolveAuthHeader(
  credentials: PagerDutyCredentials,
  requiredScope = "services.read"
): Promise<PagerDutyResult<string>> {
  const token = credentials.PAGERDUTY_API_TOKEN?.trim();
  if (token) {
    // A token pasted with a stray newline would make undici throw on the
    // header, which the fetch catch would report as "could not reach
    // PagerDuty" - a misleading answer to a fixable mistake.
    if (!isHeaderSafeToken(token)) {
      return {
        ok: false,
        failure: {
          message:
            "The PagerDuty API token contains characters that cannot go in a request header - it was probably pasted with a line break or a space. Re-copy it in Settings, Connections.",
          retryable: false,
          fault: "user",
        },
      };
    }
    return { ok: true, value: `Token token=${token}` };
  }

  const hasOAuth =
    credentials.PAGERDUTY_OAUTH_CLIENT_ID &&
    credentials.PAGERDUTY_OAUTH_CLIENT_SECRET &&
    credentials.PAGERDUTY_SUBDOMAIN;
  if (!hasOAuth) {
    // An empty credential set is not only "the form was left blank". The
    // runtime also hands back nothing when the connection has been deleted,
    // when it belongs to another organisation, and when the person who
    // created it has been deactivated - KeeperHub freezes their credentials
    // for everyone, which is the point of the freeze, but it looks identical
    // from here. Naming all three saves an hour of staring at a connection
    // that appears fine in Settings.
    return {
      ok: false,
      failure: {
        message:
          "No PagerDuty credentials are available for this node. Either the connection holds none (add a REST API token, or an OAuth client id, secret and subdomain), or it has been removed, or the person who created it has been deactivated - which freezes the connections they added. Recreating the connection under an active member fixes the last case; editing it does not, because it stays owned by its creator.",
        retryable: false,
        fault: "user",
      },
    };
  }

  const scopes = oauthScopesFor(requiredScope);
  const cached = oauthTokens.get(oauthCacheKey(credentials, scopes));
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, value: cached.header };
  }
  return await fetchOAuthHeader(credentials, scopes);
}

function restFailure(
  status: number,
  requiredScope = "services.read",
  detail?: string
): PagerDutyFailure {
  if (status === 401) {
    return {
      message:
        "PagerDuty rejected the credentials (401). Either the token is wrong or has been revoked - rotate it in Settings, Connections - or the EU service region checkbox does not match the account, which fails in exactly the same way.",
      status,
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      // The remedy differs by credential and by call, and naming the wrong one
      // sends somebody to mint a full-access API key when a scope was missing
      // from an OAuth app, or to look at Create Incident when the call that
      // failed was a read.
      message: `PagerDuty refused the request (403). The credentials are valid but lack the access this call needs (${requiredScope}). On a scoped OAuth app, grant that scope and try again. On an API key, a read-only one covers every read, and only creating an incident needs a key that is not read-only.`,
      status,
      retryable: false,
    };
  }
  // 402 is PagerDuty's documented "account does not have the abilities to
  // perform the action". That is usually a plan which simply never included
  // the feature - incident priorities are the common one - and only sometimes
  // a lapsed subscription, so it is worded as the former. Retrying cannot fix
  // either.
  if (status === 402) {
    return {
      message:
        "PagerDuty answered 402: this account's plan does not include what the request needs. Incident priorities, for one, are not on every plan. Nothing is wrong with the connection; if you expected the account to have it, check the PagerDuty subscription.",
      status,
      retryable: false,
    };
  }
  return {
    message: detail ?? `PagerDuty returned HTTP ${status}.`,
    status,
    retryable: isRetryableHttpStatus(status),
  };
}

/** One authenticated GET against the REST API, with the failure already classified. */
async function restGet<T>(
  credentials: PagerDutyCredentials,
  path: string,
  requiredScope = "services.read"
): Promise<PagerDutyResult<T>> {
  const auth = await resolveAuthHeader(credentials, requiredScope);
  if (!auth.ok) {
    return auth;
  }

  try {
    const response = await safeFetch(apiUrl(credentials, path), {
      plugin: PLUGIN,
      method: "GET",
      headers: { Authorization: auth.value, Accept: ACCEPT_V2 },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // 403 as well as 401. The fallback path caches a minimal-scope token
      // under the key of the scope set PagerDuty refused, so a call needing
      // more comes back 403 - and without this it would keep reading that same
      // token until it expired, including after somebody granted the missing
      // scope, which is exactly what the 403 message tells them to do.
      if (response.status === 401 || response.status === 403) {
        invalidateOAuthToken(credentials);
      }
      return {
        ok: false,
        failure: {
          ...restFailure(response.status, requiredScope),
          retryAfterMs: parseRetryAfterHeaderMs(
            response.headers?.get?.("retry-after")
          ),
        },
      };
    }

    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    // `isConnectionFailure` excludes timeouts and resets on purpose: it exists
    // so a non-idempotent POST is never repeated once the body may have gone.
    // This is a GET. Repeating it is free, and the timeout above is the most
    // likely transient fault on this path - classifying it as final made the
    // node's retry setting buy nothing on a slow PagerDuty, and a slow service
    // read failed the page outright. Only a blocked host is hopeless.
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty: ${getErrorMessage(error)}`,
        retryable: !(error instanceof SsrfBlockedError),
      },
    };
  }
}

type ServiceIntegrationRef = { id?: string; type?: string };

type ServiceResponseItem = {
  id?: string;
  name?: string;
  html_url?: string;
  status?: string;
  escalation_policy?: { id?: string; summary?: string };
  integrations?: ServiceIntegrationRef[];
};

const EVENTS_V2_INTEGRATION_TYPES: ReadonlySet<string> = new Set([
  "events_api_v2_inbound_integration",
  "events_api_v2_inbound_integration_reference",
]);

function toService(item: ServiceResponseItem): PagerDutyService | null {
  if (!(item.id && item.name)) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    escalationPolicyId: item.escalation_policy?.id,
    escalationPolicyName: item.escalation_policy?.summary,
    acceptsEvents: (item.integrations ?? []).some((integration) =>
      EVENTS_V2_INTEGRATION_TYPES.has(integration.type ?? "")
    ),
    status: item.status,
    htmlUrl: item.html_url,
  };
}

/**
 * The account's services, with the escalation policy each one pages and
 * whether it can take events at all. One page of 100 covers every account we
 * would show in a dropdown; the picker filters client-side from there.
 */
const PAGE_SIZE = 100;
/** Five pages is 500 services; past that the picker says it is showing a subset. */
const MAX_PAGES = 5;

/**
 * Every service the account has, up to MAX_PAGES pages.
 *
 * Paginating matters for more than completeness: the picker warns that a
 * stored service "is not in this account any more", and on a truncated list
 * that warning would be false and would invite someone to repoint a working
 * node at another team's service.
 */
export async function listServices(
  credentials: PagerDutyCredentials
): Promise<
  PagerDutyResult<{ services: PagerDutyService[]; truncated: boolean }>
> {
  const services: PagerDutyService[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await restGet<{
      services?: ServiceResponseItem[];
      more?: boolean;
    }>(
      credentials,
      `/services?limit=${PAGE_SIZE}&offset=${offset}&sort_by=name&include%5B%5D=escalation_policies&include%5B%5D=integrations`
    );
    if (!result.ok) {
      return result;
    }
    for (const item of result.value.services ?? []) {
      const service = toService(item);
      if (service) {
        services.push(service);
      }
    }
    if (!result.value.more) {
      return { ok: true, value: { services, truncated: false } };
    }
    offset += PAGE_SIZE;
  }

  return { ok: true, value: { services, truncated: true } };
}

export async function listEscalationPolicies(
  credentials: PagerDutyCredentials
): Promise<
  PagerDutyResult<{
    escalationPolicies: PagerDutyEscalationPolicy[];
    truncated: boolean;
  }>
> {
  const escalationPolicies: PagerDutyEscalationPolicy[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await restGet<{
      escalation_policies?: { id?: string; name?: string; html_url?: string }[];
      more?: boolean;
    }>(
      credentials,
      `/escalation_policies?limit=${PAGE_SIZE}&offset=${offset}&sort_by=name`,
      "escalation_policies.read"
    );
    if (!result.ok) {
      return result;
    }
    for (const item of result.value.escalation_policies ?? []) {
      if (item.id && item.name) {
        escalationPolicies.push({
          id: item.id,
          name: item.name,
          htmlUrl: item.html_url,
        });
      }
    }
    if (!result.value.more) {
      return { ok: true, value: { escalationPolicies, truncated: false } };
    }
    offset += PAGE_SIZE;
  }

  return { ok: true, value: { escalationPolicies, truncated: true } };
}

/**
 * Resolved routing keys, cached briefly in process.
 *
 * The Events API and the REST API are separate availability domains, and the
 * Events API is the one built to stay up. Reading the key over REST on every
 * single page would hand REST's availability to the alerting path; a short
 * cache keeps a REST blip from stopping a page that could otherwise be sent.
 * Keyed by region, service and the credential itself, so a rotated credential
 * or a different account never reuses another's key.
 */
const routingKeys = new Map<
  string,
  { key: string; serviceStatus?: string; expiresAt: number }
>();
const ROUTING_KEY_TTL_MS = 5 * 60 * 1000;
const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;

/** Exported for tests, which need a clean cache between cases. */
export function clearRoutingKeyCache(): void {
  routingKeys.clear();
}

/**
 * Cache key for a resolved routing key. The credential is part of it for the
 * same reason as above - a rotated token must not read another's entry - and
 * goes in as itself for the same reason too: the values in this map are
 * routing keys, which page a service on their own, so nothing was being kept
 * out of it by hashing the key.
 */
function routingKeyCacheKey(
  credentials: PagerDutyCredentials,
  serviceId: string
): string {
  return JSON.stringify([
    isEuRegion(credentials) ? "eu" : "us",
    serviceId,
    credentials.PAGERDUTY_API_TOKEN ?? "",
    credentials.PAGERDUTY_OAUTH_CLIENT_ID ?? "",
    credentials.PAGERDUTY_OAUTH_CLIENT_SECRET ?? "",
  ]);
}

export async function listPriorities(
  credentials: PagerDutyCredentials
): Promise<PagerDutyResult<PagerDutyPriority[]>> {
  const result = await restGet<{
    priorities?: {
      id?: string;
      name?: string;
      description?: string;
      self?: string;
    }[];
  }>(credentials, "/priorities?limit=100", "priorities.read");
  if (!result.ok) {
    return result;
  }
  const priorities: PagerDutyPriority[] = [];
  for (const item of result.value.priorities ?? []) {
    if (item.id && item.name) {
      priorities.push({
        id: item.id,
        name: item.name,
        description: item.description,
      });
    }
  }
  return { ok: true, value: priorities };
}

/**
 * The routing key of a service's Events API v2 integration.
 *
 * Kept out of the workflow definition on purpose: a routing key is a
 * credential, and a workflow is exported, shared and listed. It is read here,
 * per run, from the service id the node stores.
 */
export type ResolvedService = {
  routingKey: string;
  /** PagerDuty's service status, when it told us: active, warning, critical, maintenance, disabled. */
  serviceStatus?: string;
};

/** A service in one of these states accepts events and creates no incident. */
const SWALLOWING_STATUSES: ReadonlySet<string> = new Set([
  "disabled",
  "maintenance",
]);

/** A service in one of these states takes an event and raises an incident. */
const PAGING_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "warning",
  "critical",
]);

export function serviceSwallowsEvents(status: string | undefined): boolean {
  return status !== undefined && SWALLOWING_STATUSES.has(status);
}

/**
 * Whether this plugin knows what a service status means.
 *
 * PagerDuty publishes five today, and the node's whole report of what
 * happened turns on which group a status falls into: three raise an incident,
 * two swallow the event and raise none. A sixth added later would match
 * neither, and treating "not one of the two I know swallow events" as "fine"
 * would have the node reporting a page that PagerDuty never raised - silently,
 * and only on the service in that new state.
 *
 * So an unrecognised status is called out rather than assumed. The event is
 * still sent, because refusing to page over a status string this plugin has
 * not heard of would be the worse failure by far; what changes is that the
 * node says it could not tell, instead of saying everything is fine.
 */
export function serviceStatusIsRecognised(status: string | undefined): boolean {
  return (
    status === undefined ||
    PAGING_STATUSES.has(status) ||
    SWALLOWING_STATUSES.has(status)
  );
}

export async function resolveRoutingKey(
  credentials: PagerDutyCredentials,
  serviceId: string
): Promise<PagerDutyResult<ResolvedService>> {
  if (!isPagerDutyId(serviceId)) {
    return { ok: false, failure: invalidId("service", serviceId) };
  }

  const cacheKey = routingKeyCacheKey(credentials, serviceId);
  const cached = routingKeys.get(cacheKey);
  // A cached status that says the service swallows events is not reused. The
  // trigger action refuses to send at all on a disabled service, and fires the
  // backup for a maintenance window when told to, so a status cached before
  // somebody re-enabled the service would refuse to page for up to the rest of
  // the TTL - during exactly the minutes when somebody is toggling a service
  // because an incident is in progress. Re-reading costs one GET on the
  // abnormal path only. The other direction stays cached and is safe: the
  // event is posted, and PagerDuty simply raises no incident from it.
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    !serviceSwallowsEvents(cached.serviceStatus)
  ) {
    return {
      ok: true,
      value: { routingKey: cached.key, serviceStatus: cached.serviceStatus },
    };
  }

  const service = await restGet<{ service?: ServiceResponseItem }>(
    credentials,
    `/services/${encodeURIComponent(serviceId)}?include%5B%5D=integrations`
  );
  if (!service.ok) {
    if (service.failure.status === 404) {
      return {
        ok: false,
        failure: {
          message: `PagerDuty service ${serviceId} no longer exists, or these credentials cannot see it. Pick the service again on this node.`,
          status: 404,
          retryable: false,
        },
      };
    }
    return service;
  }

  const integration = (service.value.service?.integrations ?? []).find((item) =>
    EVENTS_V2_INTEGRATION_TYPES.has(item.type ?? "")
  );
  if (!integration?.id) {
    return {
      ok: false,
      failure: {
        message: `PagerDuty service ${serviceId} has no Events API v2 integration, so it cannot accept events. Add one in PagerDuty under Service, Integrations.`,
        retryable: false,
        fault: "user",
      },
    };
  }

  const detail = await restGet<{ integration?: { integration_key?: string } }>(
    credentials,
    `/services/${encodeURIComponent(serviceId)}/integrations/${encodeURIComponent(integration.id)}`
  );
  if (!detail.ok) {
    return detail;
  }

  const key = detail.value.integration?.integration_key;
  if (!key) {
    return {
      ok: false,
      failure: {
        message:
          "PagerDuty did not return the integration key for this service. The credentials may lack permission to read it.",
        retryable: false,
        fault: "user",
      },
    };
  }
  const serviceStatus = service.value.service?.status;
  pruneCache(routingKeys);
  routingKeys.set(cacheKey, {
    key,
    serviceStatus,
    expiresAt: Date.now() + ROUTING_KEY_TTL_MS,
  });
  return { ok: true, value: { routingKey: key, serviceStatus } };
}

/**
 * Resolve the routing key, retrying the transient failures.
 *
 * Without this, the retry count on the node only covered the event itself,
 * while two thirds of the requests a page makes - the service read and the
 * integration read - failed on the first rate limit or 502.
 */
export async function resolveRoutingKeyWithRetries(params: {
  credentials: PagerDutyCredentials;
  serviceId: string;
  maxRetries: number;
  baseDelayMs: number;
  wait: (ms: number) => Promise<void>;
  onRetry?: (
    failure: PagerDutyFailure,
    attempt: number,
    delayMs: number
  ) => void;
}): Promise<PagerDutyResult<ResolvedService>> {
  let result = await resolveRoutingKey(params.credentials, params.serviceId);

  for (let retry = 1; retry <= params.maxRetries; retry++) {
    if (result.ok || !result.failure.retryable) {
      break;
    }
    const delayMs = result.failure.retryAfterMs ?? params.baseDelayMs * retry;
    params.onRetry?.(result.failure, retry, delayMs);
    if (delayMs > 0) {
      await params.wait(delayMs);
    }
    result = await resolveRoutingKey(params.credentials, params.serviceId);
  }

  return result;
}

type EventsApiResponse = {
  status?: string;
  message?: string;
  dedup_key?: string;
  errors?: string[];
};

/**
 * POST one event. A 202 is the only success; a 400 names what PagerDuty
 * disliked and is never worth another attempt, while 429 and 5xx are.
 */
export async function postEvent(
  credentials: PagerDutyCredentials,
  body: PagerDutyEventBody | Record<string, unknown>,
  path = "/v2/enqueue"
): Promise<PagerDutyResult<{ dedupKey?: string; message?: string }>> {
  try {
    const response = await safeFetch(eventsUrl(credentials, path), {
      plugin: PLUGIN,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const parsed = (await response
      .json()
      .catch(() => ({}))) as EventsApiResponse;

    if (!response.ok) {
      const detail = parsed.errors?.length
        ? `${parsed.message ?? "PagerDuty rejected the event"}: ${parsed.errors.join("; ")}`
        : (parsed.message ??
          `PagerDuty rejected the event (HTTP ${response.status}).`);
      return {
        ok: false,
        failure: {
          message: detail,
          status: response.status,
          retryable: isRetryableHttpStatus(response.status),
          retryAfterMs: parseRetryAfterHeaderMs(
            response.headers?.get?.("retry-after")
          ),
        },
      };
    }

    return {
      ok: true,
      value: { dedupKey: parsed.dedup_key, message: parsed.message },
    };
  } catch (error) {
    // Any network fault is worth another attempt here, not only the ones that
    // prove the request never left the process. A chat integration has to be
    // stricter, because a reply whose response was lost would post twice; an
    // event carries a dedup key, so a duplicate merges into the same alert.
    // A dropped connection mid-flight is exactly when a page must still land.
    //
    // A blocked host is the exception, as it is for `restGet`: the guard
    // refused to make the request at all and will refuse identically every
    // time, so retrying spends the whole backoff ladder - up to five attempts
    // and the sleeps between them - on a request that cannot go out. It is
    // also the user's own configuration rather than PagerDuty being down.
    const blocked = error instanceof SsrfBlockedError;
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty: ${getErrorMessage(error)}. The event was not confirmed.`,
        retryable: !blocked,
        ...(blocked ? { fault: "user" as const } : {}),
      },
    };
  }
}

/**
 * Post an event, retrying transient failures.
 *
 * Retrying is safe here in a way it is not for a chat message: every event
 * this plugin sends carries a dedup key, so an event that arrives twice
 * updates one alert instead of paging twice. The retryable set is the shared
 * one (408, 425, 429 and the transient 5xx family) plus errors that prove the
 * request never left this process. A 400 is a payload problem and is never
 * retried. A 429 waits for the interval PagerDuty reports, when it reports
 * one, and backs off linearly otherwise.
 */
export async function postEventWithRetries(params: {
  credentials: PagerDutyCredentials;
  body: PagerDutyEventBody | Record<string, unknown>;
  path?: string;
  maxRetries: number;
  baseDelayMs: number;
  onRetry?: (
    failure: PagerDutyFailure,
    attempt: number,
    delayMs: number
  ) => void;
  wait: (ms: number) => Promise<void>;
}): Promise<PagerDutyResult<{ dedupKey?: string; message?: string }>> {
  let result = await postEvent(params.credentials, params.body, params.path);

  for (let retry = 1; retry <= params.maxRetries; retry++) {
    if (result.ok || !result.failure.retryable) {
      break;
    }
    const delayMs = result.failure.retryAfterMs ?? params.baseDelayMs * retry;
    params.onRetry?.(result.failure, retry, delayMs);
    if (delayMs > 0) {
      await params.wait(delayMs);
    }
    result = await postEvent(params.credentials, params.body, params.path);
  }

  return result;
}

/**
 * Fault domain for a PagerDuty failure. A rejected credential or a service
 * that no longer exists is the workflow author's to fix; a rate limit or a
 * 5xx is PagerDuty's.
 */
export function failureIsExternal(failure: PagerDutyFailure): boolean {
  // Set at the point the failure was built, which is the only place that knows.
  if (failure.fault) {
    return failure.fault === "external";
  }
  if (failure.status === undefined) {
    // No status and nobody said otherwise: the request got no answer.
    return true;
  }
  return failure.status >= 500 || isRetryableHttpStatus(failure.status);
}

/** One escalation policy by id. Used to tell "deleted" from "PagerDuty is unhappy" before an incident is posted. */
export async function getEscalationPolicy(
  credentials: PagerDutyCredentials,
  policyId: string
): Promise<PagerDutyResult<PagerDutyEscalationPolicy | null>> {
  if (!isPagerDutyId(policyId)) {
    return { ok: false, failure: invalidId("escalation policy", policyId) };
  }
  const result = await restGet<{
    escalation_policy?: { id?: string; name?: string; html_url?: string };
  }>(
    credentials,
    `/escalation_policies/${encodeURIComponent(policyId)}`,
    "escalation_policies.read"
  );

  if (!result.ok) {
    if (result.failure.status === 404) {
      return { ok: true, value: null };
    }
    return result;
  }

  const policy = result.value.escalation_policy;
  if (!(policy?.id && policy.name)) {
    return { ok: true, value: null };
  }
  return {
    ok: true,
    value: { id: policy.id, name: policy.name, htmlUrl: policy.html_url },
  };
}

export type CreateIncidentParams = {
  serviceId: string;
  title: string;
  fromEmail: string;
  details?: string;
  urgency?: "high" | "low";
  incidentKey?: string;
  escalationPolicyId?: string;
  /** Account priority (P1, P2, ...). REST only; an event cannot carry one. */
  priorityId?: string;
};

export type CreatedIncident = {
  id: string;
  number?: number;
  htmlUrl?: string;
  status?: string;
  /** Fields PagerDuty's ceilings forced shorter, for the node to report. */
  trims?: Trim[];
};

/**
 * POST /incidents. The only write this plugin makes, and the only action that
 * can override the escalation policy, set urgency, or carry an incident key
 * that PagerDuty rejects on repeat rather than merging.
 */
export async function createIncident(
  credentials: PagerDutyCredentials,
  params: CreateIncidentParams
): Promise<PagerDutyResult<CreatedIncident>> {
  if (!isPagerDutyId(params.serviceId)) {
    return { ok: false, failure: invalidId("service", params.serviceId) };
  }
  if (!isHeaderSafeEmail(params.fromEmail)) {
    return {
      ok: false,
      failure: {
        message:
          "The From email is not a valid email address. PagerDuty sends it as a request header, so it has to be one.",
        retryable: false,
        fault: "user",
      },
    };
  }

  const auth = await resolveAuthHeader(credentials, "incidents.write");
  if (!auth.ok) {
    return auth;
  }

  const trims: Trim[] = [];
  const incident: Record<string, unknown> = {
    type: "incident",
    title: cleanDisplayField(params.title, "Title", trims),
    service: { id: params.serviceId, type: "service_reference" },
  };
  if (params.details?.trim()) {
    // Cleaned but not bounded: PagerDuty documents no limit on an incident
    // body, and its newlines are the point.
    incident.body = {
      type: "incident_body",
      details: stripControlChars(params.details, "Details", trims),
    };
  }
  if (params.urgency) {
    incident.urgency = params.urgency;
  }
  if (params.incidentKey?.trim()) {
    incident.incident_key = trimToLimit(
      params.incidentKey.trim(),
      "Incident key",
      trims
    );
  }
  if (params.escalationPolicyId) {
    incident.escalation_policy = {
      id: params.escalationPolicyId,
      type: "escalation_policy_reference",
    };
  }
  if (params.priorityId) {
    incident.priority = {
      id: params.priorityId,
      type: "priority_reference",
    };
  }

  try {
    const response = await safeFetch(apiUrl(credentials, "/incidents"), {
      plugin: PLUGIN,
      method: "POST",
      headers: {
        Authorization: auth.value,
        Accept: ACCEPT_V2,
        "Content-Type": "application/json",
        From: params.fromEmail,
      },
      body: JSON.stringify({ incident }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const parsed = (await response.json().catch(() => ({}))) as {
      incident?: {
        id?: string;
        incident_number?: number;
        html_url?: string;
        status?: string;
      };
      error?: { message?: string; errors?: string[] };
    };

    if (!response.ok) {
      // A 403 here means the cached token lacks incidents.write, so it has
      // to be dropped for a newly granted scope to take effect.
      if (response.status === 401 || response.status === 403) {
        invalidateOAuthToken(credentials);
      }
      // PagerDuty answers a 403 here with "Access Denied", which does not
      // tell anyone that the connection is holding the read-only key the
      // setup instructions told them to make. For the credential statuses the
      // explanation leads and PagerDuty's own words follow it.
      const said = parsed.error?.errors?.length
        ? `${parsed.error.message ?? "rejected"}: ${parsed.error.errors.join("; ")}`
        : parsed.error?.message;
      const credentialProblem =
        response.status === 401 ||
        response.status === 402 ||
        response.status === 403;
      const detail = credentialProblem
        ? `${restFailure(response.status, "incidents.write").message}${said ? ` (PagerDuty said: "${said}")` : ""}`
        : (said ?? restFailure(response.status, "incidents.write").message);
      return {
        ok: false,
        failure: {
          message: detail,
          status: response.status,
          retryable: isRetryableHttpStatus(response.status),
          retryAfterMs: parseRetryAfterHeaderMs(
            response.headers?.get?.("retry-after")
          ),
        },
      };
    }

    const created = parsed.incident;
    if (!created?.id) {
      return {
        ok: false,
        failure: {
          message: "PagerDuty accepted the request but returned no incident.",
          retryable: false,
        },
      };
    }

    return {
      ok: true,
      value: {
        id: created.id,
        number: created.incident_number,
        htmlUrl: created.html_url,
        status: created.status,
        trims: trims.length > 0 ? trims : undefined,
      },
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        message: `Could not reach PagerDuty: ${getErrorMessage(error)}`,
        retryable: isConnectionFailure(error),
      },
    };
  }
}

const PAGERDUTY_HOST_SUFFIX = ".pagerduty.com";

/**
 * The account a connection actually points at, read from any html_url
 * PagerDuty returns (they are all subdomain.pagerduty.com/...). Shown next to
 * the service picker so nobody wires a production page into a sandbox account
 * without noticing - the connection name alone does not prove which account it
 * holds. Renaming the account changes this line and nothing else, because
 * every id stays the same.
 */
export function subdomainFromHtmlUrl(
  htmlUrl: string | undefined
): string | undefined {
  if (!htmlUrl) {
    return;
  }
  try {
    const host = new URL(htmlUrl).hostname.toLowerCase();
    if (!host.endsWith(PAGERDUTY_HOST_SUFFIX)) {
      return;
    }
    const label = host.slice(0, -PAGERDUTY_HOST_SUFFIX.length);
    // EU accounts publish subdomain.eu.pagerduty.com.
    const subdomain = label.endsWith(".eu") ? label.slice(0, -3) : label;
    return subdomain || undefined;
  } catch {
    return;
  }
}

/**
 * Which service region an html_url belongs to, or undefined when it cannot be
 * told. EU accounts publish subdomain.eu.pagerduty.com.
 *
 * The pickers use this to show the Events API host the node will actually
 * post to. It is read back off a URL PagerDuty returned rather than off the
 * connection, so nothing about the credential has to cross to the browser.
 */
export function isEuHtmlUrl(htmlUrl: string | undefined): boolean | undefined {
  if (!htmlUrl) {
    return;
  }
  try {
    const host = new URL(htmlUrl).hostname.toLowerCase();
    if (!host.endsWith(PAGERDUTY_HOST_SUFFIX)) {
      return;
    }
    return host.slice(0, -PAGERDUTY_HOST_SUFFIX.length).endsWith(".eu");
  } catch {
    return;
  }
}

export type IncidentLookup = {
  status: "triggered" | "acknowledged" | "resolved" | "unknown";
  id?: string;
  htmlUrl?: string;
  /** The priority PagerDuty ended up putting on the incident, when it has one. */
  priority?: string;
};

/**
 * Find the incident carrying a dedup key on a service.
 *
 * Exists because the Events API cannot answer "did that actually land". It
 * accepts an acknowledge or a resolve with 202 and then drops it when no open
 * alert matches - the alert was already resolved, the key was never used, or
 * the event went through a different service's routing key. A read here turns
 * that silence into a state the workflow can report.
 *
 * "unknown" is a real answer, not an error: a service with alert grouping
 * turned on produces incidents that carry child alerts and no incident key, so
 * a miss does not prove the alert is absent. Callers must not fail a run on it.
 */
export async function findIncidentByKey(
  credentials: PagerDutyCredentials,
  params: { serviceId: string; incidentKey: string }
): Promise<PagerDutyResult<IncidentLookup>> {
  if (!isPagerDutyId(params.serviceId)) {
    return { ok: false, failure: invalidId("service", params.serviceId) };
  }
  const query = new URLSearchParams({
    incident_key: params.incidentKey,
    limit: "1",
    // Newest first. PagerDuty defaults to created_at ascending, and the
    // default dedup key is per node - every incident that node has ever
    // opened carries the same key - so with limit 1 the answer would be the
    // first incident of the search window rather than the one just acted on.
    // A resolve would read back the status of something from months ago.
    sort_by: "created_at:desc",
    // Without a range PagerDuty searches the last month, so a long-running
    // incident would read back as "unknown". Six months is its maximum.
    since: new Date(Date.now() - SIX_MONTHS_MS).toISOString(),
  });
  query.append("service_ids[]", params.serviceId);
  for (const status of ["triggered", "acknowledged", "resolved"]) {
    query.append("statuses[]", status);
  }

  const result = await restGet<{
    incidents?: {
      id?: string;
      status?: string;
      html_url?: string;
      priority?: { summary?: string; id?: string } | null;
    }[];
  }>(credentials, `/incidents?${query.toString()}`, "incidents.read");
  if (!result.ok) {
    return result;
  }

  const incident = result.value.incidents?.[0];
  if (!incident?.id) {
    return { ok: true, value: { status: "unknown" } };
  }

  const status = incident.status;
  return {
    ok: true,
    value: {
      status:
        status === "triggered" ||
        status === "acknowledged" ||
        status === "resolved"
          ? status
          : "unknown",
      id: incident.id,
      htmlUrl: incident.html_url,
      priority: incident.priority?.summary,
    },
  };
}
