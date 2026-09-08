import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import {
  lookup as dnsLookup,
  promises as dnsPromises,
  type LookupAddress,
} from "node:dns";
import { BlockList, isIP } from "node:net";
import { captureException } from "@sentry/nextjs";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { logWarn } from "@/lib/logging";
import { getMetricsCollector } from "@/lib/metrics";
import {
  SSRF_BLOCKED_HOST_EXACT,
  SSRF_BLOCKED_HOST_SUFFIXES,
  SSRF_IPV4_BROADCAST_ADDRESSES,
  SSRF_IPV4_CIDRS,
  SSRF_IPV6_CIDRS,
  SSRF_IPV6_LITERAL_ADDRESSES,
  SSRF_NAT64_PREFIX_CIDR,
} from "@/lib/ssrf-blocklist";

export type SsrfBlockReason =
  | "scheme"
  | "private-ip"
  | "loopback"
  | "link-local"
  | "multicast"
  | "reserved"
  | "ipv4-mapped-private"
  | "ipv4-nat64-private"
  | "blocked-host";

export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
  readonly hostname: string;
  readonly resolvedIp?: string;
  readonly reason: SsrfBlockReason;

  constructor(params: {
    hostname: string;
    resolvedIp?: string;
    reason: SsrfBlockReason;
    message: string;
  }) {
    super(params.message);
    this.name = "SsrfBlockedError";
    this.hostname = params.hostname;
    this.resolvedIp = params.resolvedIp;
    this.reason = params.reason;
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

const IPV4_MAPPED_PREFIX = "::ffff:";

const IPV4_MULTICAST_REGEX = /^(22[4-9]|23\d)\./;

const IPV4_MAPPED_HEX_REGEX = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

// NAT64 well-known prefix per RFC 6052 — 64:ff9b::/96. The last 32 bits
// encode an IPv4 address. We recognise three textual forms a resolver may
// return: canonical "64:ff9b::WWXX:YYZZ", uncompressed
// "64:ff9b:0:0:0:0:WWXX:YYZZ", and dotted-quad "64:ff9b::1.2.3.4".
const NAT64_CANONICAL_REGEX = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const NAT64_UNCOMPRESSED_REGEX =
  /^64:ff9b:0:0:0:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const NAT64_DOTTED_REGEX = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/;

/**
 * Builds the runtime BlockList from the shared data in
 * `lib/ssrf-blocklist.ts`. See that module for the rationale on which
 * ranges are blanket-blocked and which are handled specially (IPv4-mapped
 * IPv6 and the well-known NAT64 prefix).
 */
function buildBlockList(): BlockList {
  const list = new BlockList();
  for (const [addr, prefix] of SSRF_IPV4_CIDRS) {
    list.addSubnet(addr, prefix, "ipv4");
  }
  for (const addr of SSRF_IPV4_BROADCAST_ADDRESSES) {
    list.addAddress(addr, "ipv4");
  }
  for (const addr of SSRF_IPV6_LITERAL_ADDRESSES) {
    list.addAddress(addr, "ipv6");
  }
  for (const [addr, prefix] of SSRF_IPV6_CIDRS) {
    list.addSubnet(addr, prefix, "ipv6");
  }
  return list;
}

const BLOCK_LIST = buildBlockList();

const NAT64_BLOCK_LIST = (() => {
  const list = new BlockList();
  list.addSubnet(SSRF_NAT64_PREFIX_CIDR[0], SSRF_NAT64_PREFIX_CIDR[1], "ipv6");
  return list;
})();

function reasonForIpv4(ip: string): SsrfBlockReason {
  if (ip.startsWith("127.")) {
    return "loopback";
  }
  if (ip.startsWith("169.254.")) {
    return "link-local";
  }
  if (IPV4_MULTICAST_REGEX.test(ip)) {
    return "multicast";
  }
  if (ip.startsWith("240.") || ip === "255.255.255.255") {
    return "reserved";
  }
  return "private-ip";
}

function reasonForIpv6(ip: string): SsrfBlockReason {
  const normalised = ip.toLowerCase();
  if (normalised === "::1") {
    return "loopback";
  }
  if (normalised.startsWith(IPV4_MAPPED_PREFIX)) {
    return "ipv4-mapped-private";
  }
  if (normalised.startsWith("fe80:")) {
    return "link-local";
  }
  if (normalised.startsWith("ff")) {
    return "multicast";
  }
  return "private-ip";
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped IPv6 address. Handles both
 * dotted-quad (`::ffff:169.254.169.254`) and hex (`::ffff:a9fe:a9fe`) forms.
 */
function extractMappedIpv4(ipv6: string): string | undefined {
  const lower = ipv6.toLowerCase();
  if (!lower.startsWith(IPV4_MAPPED_PREFIX)) {
    return;
  }
  const suffix = lower.slice(IPV4_MAPPED_PREFIX.length);
  if (isIP(suffix) === 4) {
    return suffix;
  }
  const hexMatch = suffix.match(IPV4_MAPPED_HEX_REGEX);
  if (!hexMatch) {
    return;
  }
  const high = Number.parseInt(hexMatch[1] ?? "", 16);
  const low = Number.parseInt(hexMatch[2] ?? "", 16);
  if (!(Number.isFinite(high) && Number.isFinite(low))) {
    return;
  }
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    "."
  );
}

function hexGroupsToIpv4(highHex: string, lowHex: string): string | undefined {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  if (!(Number.isFinite(high) && Number.isFinite(low))) {
    return;
  }
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    "."
  );
}

/**
 * Extract the embedded IPv4 from a NAT64 well-known prefix address
 * (`64:ff9b::/96`, RFC 6052). The last 32 bits encode the IPv4 destination.
 * Returns undefined for non-NAT64 input or an unrecognised textual form.
 */
function extractNat64Ipv4(ipv6: string): string | undefined {
  const lower = ipv6.toLowerCase();
  const canonical = lower.match(NAT64_CANONICAL_REGEX);
  if (canonical?.[1] && canonical[2]) {
    return hexGroupsToIpv4(canonical[1], canonical[2]);
  }
  const uncompressed = lower.match(NAT64_UNCOMPRESSED_REGEX);
  if (uncompressed?.[1] && uncompressed[2]) {
    return hexGroupsToIpv4(uncompressed[1], uncompressed[2]);
  }
  const dotted = lower.match(NAT64_DOTTED_REGEX);
  if (dotted?.[1] && isIP(dotted[1]) === 4) {
    return dotted[1];
  }
  return;
}

/**
 * Check an IP literal against the denylist. For IPv4-mapped IPv6 addresses,
 * the embedded IPv4 is also matched against the IPv4 denylist so an IPv6
 * literal cannot be used to bypass an IPv4-range check.
 */
export function isBlockedIp(
  ip: string
): { blocked: true; reason: SsrfBlockReason } | { blocked: false } {
  const family = isIP(ip);
  if (family === 0) {
    return { blocked: false };
  }

  if (family === 6 && NAT64_BLOCK_LIST.check(ip, "ipv6")) {
    const embedded = extractNat64Ipv4(ip);
    if (embedded === undefined) {
      // Address is inside 64:ff9b::/96 but the textual form is unfamiliar
      // and we can't read the embedded IPv4. Block defensively rather than
      // pass through unvalidated — extending the form-aware extractor is
      // safer than weakening the guard.
      return { blocked: true, reason: "ipv4-nat64-private" };
    }
    if (BLOCK_LIST.check(embedded, "ipv4")) {
      return { blocked: true, reason: "ipv4-nat64-private" };
    }
    return { blocked: false };
  }

  const familyKey = family === 4 ? "ipv4" : "ipv6";
  if (BLOCK_LIST.check(ip, familyKey)) {
    return {
      blocked: true,
      reason: family === 4 ? reasonForIpv4(ip) : reasonForIpv6(ip),
    };
  }

  if (family === 6) {
    const mapped = extractMappedIpv4(ip);
    if (mapped && BLOCK_LIST.check(mapped, "ipv4")) {
      return { blocked: true, reason: "ipv4-mapped-private" };
    }
  }

  return { blocked: false };
}

const BLOCKED_HOST_EXACT = new Set<string>(SSRF_BLOCKED_HOST_EXACT);
const BLOCKED_HOST_SUFFIXES = SSRF_BLOCKED_HOST_SUFFIXES;

/**
 * Pre-DNS hostname denylist. Pure string match - no DNS lookup, no IP
 * resolution. Intended as defense-in-depth on top of `isBlockedIp`: catches
 * hosts that are internal by NAME (localhost, *.svc.cluster.local, EC2 VPC
 * internal hostnames like *.compute.internal) before any resolver gets to
 * synthesise a record. Pairs with the existing IP-resolution checks in
 * `safeFetch` and `assertUrlIsPublic`.
 *
 * Returns `{ blocked: false }` for IP literals - those are validated by
 * `isBlockedIp` instead.
 */
export function isBlockedHost(
  host: string
): { blocked: true; reason: "blocked-host" } | { blocked: false } {
  if (host === "") {
    return { blocked: false };
  }
  let normalised = host.trim().toLowerCase();
  if (normalised.endsWith(".")) {
    normalised = normalised.slice(0, -1);
  }
  if (normalised === "") {
    return { blocked: false };
  }
  if (BLOCKED_HOST_EXACT.has(normalised)) {
    return { blocked: true, reason: "blocked-host" };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (normalised.endsWith(suffix)) {
      return { blocked: true, reason: "blocked-host" };
    }
  }
  return { blocked: false };
}

export function isShadowMode(): boolean {
  // Real production can never enter shadow mode, regardless of any flag. This
  // closes the foot-gun where a stray env var silently re-enables an
  // unauthenticated SSRF primitive in prod. CI runs the app under
  // NODE_ENV="production" too, so it is exempted via CI to keep the
  // localhost-anvil e2e suites (which opt into shadow) working.
  if (process.env.NODE_ENV === "production" && process.env.CI !== "true") {
    return false;
  }
  // Fail-closed by default elsewhere: SSRF blocking is enforced unless an
  // environment explicitly opts into shadow mode with SAFE_FETCH_SHADOW="true"
  // (any other value, including unset, enforces). Shadow mode is a dev/CI-only
  // escape hatch for reaching localhost/private targets through safeFetch
  // (e.g. a local anvil node).
  return process.env.SAFE_FETCH_SHADOW === "true";
}

type BlockContext = {
  hostname: string;
  resolvedIp?: string;
  reason: SsrfBlockReason;
  plugin?: string;
};

/**
 * Carries per-request state across the async boundary into the
 * module-level Agent's lookup callback, where the original `safeFetch`
 * closure is out of scope.
 *
 * - `plugin` attributes DNS-path blocks (without this, they record
 *   plugin_name="unknown" — precisely the case the shadow-mode soak
 *   needs to attribute).
 * - `initialBlockRecorded` lets the synchronous entry-point checks
 *   (`isBlockedHost` and the IP-literal `isBlockedIp` check) tell the
 *   connector "we already counted this request as blocked." Without this
 *   signal, a single shadow-mode request to e.g. `http://localhost/` is
 *   counted twice (once for the hostname-pattern match, once again when
 *   the connector's `dnsLookup` resolves it to 127.0.0.1). The flag
 *   short-circuits the second `recordBlock` while still letting the
 *   connector enforce in non-shadow mode.
 */
type SafeFetchStore = {
  plugin?: string;
  initialBlockRecorded?: boolean;
};

const pluginContext = new AsyncLocalStorage<SafeFetchStore>();

function currentPlugin(): string | undefined {
  return pluginContext.getStore()?.plugin;
}

function initialBlockAlreadyRecorded(): boolean {
  return pluginContext.getStore()?.initialBlockRecorded === true;
}

function recordBlock(ctx: BlockContext, shadow: boolean): void {
  const metrics = getMetricsCollector();
  metrics.incrementCounter("safe_fetch.blocks.total", {
    reason: ctx.reason,
    plugin_name: ctx.plugin ?? "unknown",
    shadow: shadow ? "true" : "false",
  });

  // Do NOT route through logUserError: it forwards caller labels to a
  // Prometheus error metric with a fixed initial labelset, which rejects
  // hostname/resolved_ip with "Added label not included in initial labelset"
  // and turns shadow mode into a synchronous throw.
  const modeSuffix = shadow ? " (shadow mode)" : "";
  const resolvedSuffix =
    ctx.resolvedIp !== undefined && ctx.resolvedIp !== ctx.hostname
      ? ` -> ${ctx.resolvedIp}`
      : "";
  const pluginSuffix =
    ctx.plugin === undefined ? "" : ` [plugin=${ctx.plugin}]`;
  // logWarn (JSON line only, NO metric, NO Sentry): the metric and Sentry
  // capture are emitted directly above/below. Routing through
  // logUserError/logSystemError would emit a second error metric whose fixed
  // initial labelset rejects hostname/resolved_ip and turns shadow mode into
  // a synchronous throw.
  logWarn(
    `[safe-fetch] Blocked outbound request${modeSuffix}: ${ctx.hostname}${resolvedSuffix} (reason=${ctx.reason})${pluginSuffix}`
  );

  captureException(new Error(`safe-fetch block: ${ctx.reason}`), {
    level: "warning",
    tags: {
      safe_fetch_reason: ctx.reason,
      safe_fetch_shadow: shadow ? "true" : "false",
      plugin_name: ctx.plugin ?? "unknown",
    },
    extra: {
      hostname: ctx.hostname,
      resolved_ip: ctx.resolvedIp,
    },
  });
}

function blockedMessage(ctx: BlockContext): string {
  const ipPart = ctx.resolvedIp ? ` (resolved to ${ctx.resolvedIp})` : "";
  return `Outbound request to ${ctx.hostname}${ipPart} blocked by SSRF policy (${ctx.reason}).`;
}

export function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function extractUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * Custom undici connector that resolves DNS, validates the resolved IP, and
 * only then hands off to the default TCP/TLS connector. Invoked per TCP
 * connection including redirect hops, so validation fires every time.
 *
 * The base connector is given the already-resolved IP as `hostname`, so it
 * does not perform a second DNS lookup — this closes the TOCTOU window
 * between our check and the socket handshake.
 */
type ConnectOptions = Parameters<ReturnType<typeof buildConnector>>[0];
type ConnectCallback = Parameters<ReturnType<typeof buildConnector>>[1];

const baseConnector = buildConnector({});

function validatingConnect(
  options: ConnectOptions,
  callback: ConnectCallback
): void {
  const { hostname } = options;

  // IP literals are caught at the URL-entry check in `safeFetch` already,
  // so `hostname` here is expected to be a domain name. Still, resolve it
  // and re-check defensively — covers any code path that might feed an IP
  // through the connector directly.
  dnsLookup(hostname, { family: 0 }, (err, address) => {
    if (err) {
      callback(err as Error, null);
      return;
    }
    const resolved = String(address);
    const check = isBlockedIp(resolved);
    const shadow = isShadowMode();
    const plugin = currentPlugin();

    if (check.blocked) {
      if (!initialBlockAlreadyRecorded()) {
        recordBlock(
          { hostname, resolvedIp: resolved, reason: check.reason, plugin },
          shadow
        );
      }
      if (!shadow) {
        callback(
          new SsrfBlockedError({
            hostname,
            resolvedIp: resolved,
            reason: check.reason,
            message: blockedMessage({
              hostname,
              resolvedIp: resolved,
              reason: check.reason,
              plugin,
            }),
          }),
          null
        );
        return;
      }
    }

    // Hand off to the default connector with the already-resolved address.
    baseConnector({ ...options, hostname: resolved }, callback);
  });
}

/**
 * Module-level Agent. Pooling outbound sockets across requests is fine because
 * the connector fires per connection, not per Agent.
 */
const safeAgent = new Agent({ connect: validatingConnect });

export type SafeFetchOptions = RequestInit & {
  /** Plugin identifier for observability (e.g. "code", "webhook"). */
  plugin?: string;
};

/**
 * Drop-in replacement for `fetch` that refuses to connect to private,
 * loopback, link-local, or reserved addresses. Non-http(s) schemes are
 * rejected at the entry. IP-literal URLs are validated before any network
 * call; DNS-resolved IPs are validated via a custom undici Agent lookup on
 * every redirect hop.
 *
 * Enforce mode is the default (fail-closed): blocked requests throw
 * `SsrfBlockedError`. Set `SAFE_FETCH_SHADOW="true"` to opt into shadow mode
 * (dev/CI only -- real production always enforces), where blocks are logged
 * and counted but the request still proceeds.
 */
export async function safeFetch(
  input: RequestInfo | URL,
  init?: SafeFetchOptions
): Promise<Response> {
  const plugin = init?.plugin;
  const shadow = isShadowMode();

  const rawUrl = extractUrlString(input);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    throw new TypeError(`safe-fetch: invalid URL "${rawUrl}"`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    recordBlock(
      { hostname: parsed.hostname, reason: "scheme", plugin },
      shadow
    );
    if (!shadow) {
      throw new SsrfBlockedError({
        hostname: parsed.hostname,
        reason: "scheme",
        message: `safe-fetch: scheme "${parsed.protocol}" not allowed`,
      });
    }
  }

  const hostname = stripIpv6Brackets(parsed.hostname);

  // Tracks whether one of the synchronous entry-point checks below has
  // already incremented the block counter for this request. In shadow
  // mode, execution continues past the block, the request reaches the
  // connector, and the connector's own `isBlockedIp` check would record
  // a second block for the same request (the resolved IP for a hostname
  // pattern, or the literal itself for an IP-URL). Passing this flag
  // through `pluginContext` lets the connector skip its `recordBlock`
  // while still enforcing in non-shadow mode.
  let initialBlockRecorded = false;

  const hostCheck = isBlockedHost(hostname);
  if (hostCheck.blocked) {
    recordBlock({ hostname, reason: hostCheck.reason, plugin }, shadow);
    initialBlockRecorded = true;
    if (!shadow) {
      throw new SsrfBlockedError({
        hostname,
        reason: hostCheck.reason,
        message: blockedMessage({
          hostname,
          reason: hostCheck.reason,
          plugin,
        }),
      });
    }
  }

  if (isIP(hostname) !== 0) {
    const check = isBlockedIp(hostname);
    if (check.blocked) {
      recordBlock(
        { hostname, resolvedIp: hostname, reason: check.reason, plugin },
        shadow
      );
      initialBlockRecorded = true;
      if (!shadow) {
        throw new SsrfBlockedError({
          hostname,
          resolvedIp: hostname,
          reason: check.reason,
          message: blockedMessage({
            hostname,
            resolvedIp: hostname,
            reason: check.reason,
            plugin,
          }),
        });
      }
    }
  }

  const { plugin: _omit, ...fetchInit } = init ?? {};

  // undici's fetch accepts a `dispatcher` option at runtime that is not part
  // of the DOM `RequestInit` type, and undici's own `RequestInit` differs
  // from the DOM's on `body` nullability. Build the call args via the
  // parameter type of the function we're calling to avoid `any`.
  type UndiciFetchInit = Parameters<typeof undiciFetch>[1];
  const initWithDispatcher = {
    ...fetchInit,
    dispatcher: safeAgent,
  } as unknown as UndiciFetchInit;

  // Run the fetch inside the plugin-context store so the shared Agent's
  // DNS lookup can attribute blocks to the calling plugin, and so the
  // connector can suppress a duplicate `recordBlock` when the
  // synchronous checks above have already counted this request.
  const response = await pluginContext.run(
    { plugin, initialBlockRecorded },
    () => undiciFetch(rawUrl, initWithDispatcher)
  );
  return response as unknown as Response;
}

/**
 * Pre-flight URL guard for code paths that persist or hand off a URL to a
 * client that does not route through `safeFetch` (RPC providers, postgres
 * connection-test, etc.).
 *
 * Resolves the hostname via DNS and rejects if any returned address is in
 * the SSRF denylist. IP-literal hostnames are checked directly without DNS.
 *
 * Always-on (no shadow flag): callers use this when there is no second line
 * of defense at fetch time, so the entire SSRF surface depends on this
 * check. Throws `SsrfBlockedError` on a denylist hit, `TypeError` on a
 * malformed URL or empty hostname, and a plain `Error` on DNS failure.
 *
 * Caveat: this is a write-time check. An attacker-controlled domain that
 * resolves to a public IP at validation time and re-binds to a private IP
 * before the fetch (DNS rebinding) is not blocked here. Pair this with the
 * runtime `safeFetch` guard wherever the URL is later used.
 */
export async function assertUrlIsPublic(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError(`Invalid URL: ${rawUrl}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new SsrfBlockedError({
      hostname: parsed.hostname,
      reason: "scheme",
      message: `URL scheme "${parsed.protocol}" is not allowed`,
    });
  }

  const hostname = stripIpv6Brackets(parsed.hostname);
  if (hostname === "") {
    throw new TypeError(`URL has no hostname: ${rawUrl}`);
  }

  const hostCheck = isBlockedHost(hostname);
  if (hostCheck.blocked) {
    throw new SsrfBlockedError({
      hostname,
      reason: hostCheck.reason,
      message: blockedMessage({ hostname, reason: hostCheck.reason }),
    });
  }

  if (isIP(hostname) !== 0) {
    const verdict = isBlockedIp(hostname);
    if (verdict.blocked) {
      throw new SsrfBlockedError({
        hostname,
        resolvedIp: hostname,
        reason: verdict.reason,
        message: blockedMessage({
          hostname,
          resolvedIp: hostname,
          reason: verdict.reason,
        }),
      });
    }
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dnsPromises.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Cannot resolve host: ${hostname}`);
  }

  for (const addr of addresses) {
    const verdict = isBlockedIp(addr.address);
    if (verdict.blocked) {
      throw new SsrfBlockedError({
        hostname,
        resolvedIp: addr.address,
        reason: verdict.reason,
        message: blockedMessage({
          hostname,
          resolvedIp: addr.address,
          reason: verdict.reason,
        }),
      });
    }
  }
}
