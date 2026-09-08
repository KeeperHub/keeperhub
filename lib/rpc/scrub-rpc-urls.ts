/**
 * Strip secrets out of any URL substrings inside an arbitrary string.
 *
 * Defense-in-depth pipeline:
 *   1. Drop query strings on any http(s)/ws(s) URL.
 *   2. Mask path segments that look like API keys for known providers
 *      (Alchemy /v2/<key>, Infura /v3/<key>, QuickNode .quiknode.pro/<key>,
 *      Ankr rpc.ankr.com/<chain>/<key>).
 *   3. As a generic fallback, mask any path segment that looks opaque
 *      (32+ chars of base58/base64).
 *
 * The host and the path prefix up to the secret are preserved on purpose so
 * debug output still tells an operator which provider failed. We mask the
 * trailing secret, not the whole URL.
 *
 * Failure mode: if a vendor inlines its key in a shape none of these
 * patterns match (e.g. an opaque 8-char host prefix, or a custom header
 * echoed into a multi-line error body), this helper passes the string
 * through unchanged. The remaining mitigation is the higher-level guidance
 * to log `code` + `shortMessage` instead of full messages (ethers v6 today
 * does not inline `requestUrl` into `shortMessage`).
 *
 * `scrubSentryEvent` below applies this to outbound Sentry events, which is
 * the only path that carries a raw provider error without going through
 * `buildErrPayload` first.
 */

const URL_RE = /\bhttps?:\/\/[^\s)'"<>]+|wss?:\/\/[^\s)'"<>]+/gi;

// Patterns whose match ends at the secret segment. Each is applied to the
// query-stripped URL; the trailing secret is masked while the provider-
// identifying prefix is kept.
const PROVIDER_KEY_PATTERNS: readonly RegExp[] = [
  // Alchemy:  https://<network>.g.alchemy.com/v2/<KEY>
  // Infura:   https://mainnet.infura.io/v3/<KEY>
  /\/v[23]\/[A-Za-z0-9_-]{16,}/g,
  // QuickNode: https://<name>.<chain>.quiknode.pro/<KEY>/
  /\.quiknode\.pro\/[A-Za-z0-9_-]{16,}/g,
  // Ankr premium: https://rpc.ankr.com/<chain>/<KEY>
  /rpc\.ankr\.com\/[a-z-]+\/[A-Za-z0-9_-]{16,}/g,
  // dRPC load balancer: https://lb.drpc.live/<chain>/<KEY>
  //                     wss://lb.drpc.live/<chain>/<KEY>
  // Explicit pattern (rather than relying on the generic 32+ fallback below)
  // so a future shorter dRPC key still gets caught and the chain segment
  // stays visible in masked output.
  /lb\.drpc\.live\/[a-z0-9-]+\/[A-Za-z0-9_-]{16,}/g,
  // Generic 32+ char opaque path segment as a last-resort mask. Anchored
  // on the leading "/" so it does not eat into hostnames.
  /\/[A-Za-z0-9_-]{32,}(?=\/|$)/g,
];

function maskUrl(url: string): string {
  const queryIdx = url.indexOf("?");
  const base = queryIdx === -1 ? url : url.slice(0, queryIdx);

  let masked = base;
  for (const pattern of PROVIDER_KEY_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      const slash = match.lastIndexOf("/");
      return slash >= 0
        ? `${match.slice(0, slash + 1)}[REDACTED]`
        : "[REDACTED]";
    });
  }

  return queryIdx === -1 ? masked : `${masked}?[REDACTED-QUERY]`;
}

export function scrubRpcUrls(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(URL_RE, maskUrl);
}

/**
 * The parts of a Sentry event that carry free text an SDK error can have
 * inlined a provider URL into. Structural rather than imported from
 * `@sentry/*` so this module stays dependency-free; the real `ErrorEvent` is
 * assignable to it at the `beforeSend` call site.
 */
type ScrubbableSentryEvent = {
  message?: string;
  logentry?: { message?: string };
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string }[];
};

/**
 * Scrub provider secrets out of an outbound Sentry event, in place.
 *
 * `logSystemError`/`logSystemWarn` scrub the Loki payload via `buildErrPayload`
 * but hand `captureException` the original Error, so a viem/ethers error whose
 * message inlines a keyed RPC URL reaches Sentry verbatim. The `exception`
 * sweep covers the `cause` chain too: the LinkedErrors integration flattens it
 * into additional `exception.values` entries, each of which is scrubbed here.
 */
export function scrubSentryEvent(event: ScrubbableSentryEvent): void {
  if (event.message !== undefined) {
    event.message = scrubRpcUrls(event.message);
  }
  if (event.logentry?.message !== undefined) {
    event.logentry.message = scrubRpcUrls(event.logentry.message);
  }
  for (const value of event.exception?.values ?? []) {
    if (value.value !== undefined) {
      value.value = scrubRpcUrls(value.value);
    }
  }
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message !== undefined) {
      breadcrumb.message = scrubRpcUrls(breadcrumb.message);
    }
  }
}

const URL_PLACEHOLDER = "[REDACTED-URL]";

/**
 * Hosts we operate or configure as RPC providers (CHAIN_RPC_CONFIG and the
 * public fallbacks). Used by `redactSecretUrls` to drop provider URLs whose
 * path carries no detectable secret - the host itself is what must not reach
 * users.
 */
const KNOWN_PROVIDER_HOSTS =
  /\/\/[^/\s]*(g\.alchemy\.com|infura\.io|quiknode\.pro|rpc\.ankr\.com|drpc\.(live|org)|chain\.techops\.services|publicnode\.com|flashbots\.net|arbitrum\.io|binance\.org|polygon\.technology|solana\.com|tempo\.xyz)/i;

/**
 * Replace EVERY URL with a placeholder. For contexts where any URL is a
 * provider endpoint by construction (RPC failover errors, web3 step errors)
 * and provider identity - including the host - must not reach users.
 * Idempotent: the placeholder contains no URL.
 */
export function redactAllUrls(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(URL_RE, URL_PLACEHOLDER);
}

/**
 * Replace a URL with a placeholder only when it looks provider- or
 * secret-related: known provider host, a key-shaped path segment, a query
 * string, or a previously masked `[REDACTED]` segment. Plain URLs (e.g. a
 * user's own webhook endpoint in a webhook step error) pass through, so this
 * is safe on error text from arbitrary steps.
 */
export function redactSecretUrls(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(URL_RE, (url) => {
    if (url.includes("?") || url.includes("[REDACTED]")) {
      return URL_PLACEHOLDER;
    }
    if (KNOWN_PROVIDER_HOSTS.test(url)) {
      return URL_PLACEHOLDER;
    }
    for (const pattern of PROVIDER_KEY_PATTERNS) {
      // Reset lastIndex: these are /g/ regexes shared with maskUrl.
      pattern.lastIndex = 0;
      if (pattern.test(url)) {
        return URL_PLACEHOLDER;
      }
    }
    return url;
  });
}
