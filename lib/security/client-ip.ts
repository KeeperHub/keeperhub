/**
 * Which request headers carry the client's IP address.
 *
 * Source of truth shared by:
 * - better-auth config (`lib/auth.ts`) - rate-limit keys and `sessions.ip_address`
 * - `resolveClientIpFromHeaders` (`lib/security/login-risk.ts`) - the session-minting
 *   routes that write `sessions.ip_address` through Drizzle instead of better-auth
 *
 * The header name was fixed at `CF-Connecting-IP` in both places. Cloudflare sets that
 * header at its own edge, so a deployment KeeperHub does not run resolves no address at
 * all: better-auth keys every rate limit on one shared bucket and the session row records
 * an empty string, while the Drizzle paths record NULL. Nothing fails loudly. This is the
 * seam that lets such a deployment name the header its own proxy sets.
 *
 * Both lists are read once at module load rather than per call, because `lib/auth.ts`
 * builds its better-auth options at import time and could not honour a later change.
 *
 * Deliberately NOT prefixed NEXT_PUBLIC_. Next inlines those into the server bundle too
 * whenever they are set at build time, which would bake the builder's value into every
 * image built from this tree.
 */

/**
 * The header consulted before this file existed. Unset yields exactly this, so KeeperHub's
 * own deployments are unaffected.
 */
const DEFAULT_CLIENT_IP_HEADERS: readonly string[] = ["cf-connecting-ip"];

/**
 * RFC 7230 token syntax, which is what a header name may contain. An entry with a space,
 * a colon or a quote is a malformed config line rather than a header anyone can send, so
 * it is dropped instead of being passed to `Headers.get`.
 */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Header names to try, in order, comma-separated, e.g.
 *   CLIENT_IP_HEADERS=X-Real-IP
 *
 * Names are lowercased for comparison only; `Headers.get` is case-insensitive either way.
 *
 * A list that parses to nothing falls back to the default rather than to an empty list.
 * An empty list would make better-auth fall back to its own `x-forwarded-for` default,
 * which is the opposite of what an operator who set the variable asked for.
 */
function parseClientIpHeaders(raw: string | undefined): readonly string[] {
  if (!raw) {
    return DEFAULT_CLIENT_IP_HEADERS;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && HEADER_NAME_PATTERN.test(entry));
  return parsed.length > 0 ? parsed : DEFAULT_CLIENT_IP_HEADERS;
}

/**
 * Proxy addresses or CIDR ranges the request passes through, comma-separated, e.g.
 *   CLIENT_IP_TRUSTED_PROXIES=10.42.0.0/16,192.168.1.5
 *
 * Only better-auth reads this. Without it better-auth refuses a header that carries more
 * than one comma-separated hop, because the leftmost hop is caller-controlled and it has no
 * way to tell which hops are its own proxies. Naming the proxies lets it walk the chain from
 * the right and take the first hop that is not one of them.
 *
 * Entries are not validated here. better-auth parses each one and logs the invalid ones,
 * so a second parser would only disagree with it.
 */
function parseTrustedProxies(raw: string | undefined): readonly string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const CLIENT_IP_HEADERS: readonly string[] = parseClientIpHeaders(
  process.env.CLIENT_IP_HEADERS
);

export const CLIENT_IP_TRUSTED_PROXIES: readonly string[] = parseTrustedProxies(
  process.env.CLIENT_IP_TRUSTED_PROXIES
);

/**
 * Resolve one header value to a single client address.
 *
 * A header can carry a chain of hops, `client, proxy1, proxy2`. Only the
 * rightmost hop was written by something we control; every hop to its left was
 * copied from what the previous hop received, so a caller can put anything it
 * likes at the front. Taking the leftmost value is therefore the same as
 * letting the caller choose its own address.
 *
 * With no trusted proxy named, a value carrying more than one hop is refused
 * outright. With proxies named, the chain is walked from the right and the
 * first hop that is not one of them is the client. A malformed hop breaks the
 * walk and fails closed rather than returning a proxy as the client.
 *
 * This mirrors what better-auth does with the same header, so the two routes
 * into `sessions.ip_address` agree instead of one accepting what the other
 * rejects.
 */
export function resolveIpFromHeaderValue(value: string): string | null {
  const hops = value
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  if (hops.length === 0) {
    return null;
  }

  // Gate on the parsed networks, not the raw entries. A list of nothing but
  // typos would otherwise engage chain mode with no network to match, and the
  // rightmost hop - one of our own proxies - would be returned as the client.
  if (TRUSTED_PROXY_NETWORKS.length > 0) {
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i];
      const bytes = hop ? ipToBytes(hop) : null;
      if (!bytes) {
        return null;
      }
      if (TRUSTED_PROXY_NETWORKS.some((net) => matchesCidr(bytes, net))) {
        continue;
      }
      return hop;
    }
    return null;
  }

  if (hops.length !== 1) {
    return null;
  }
  const only = hops[0];
  return only && ipToBytes(only) ? only : null;
}

/** Raw bytes of an IPv4 or IPv6 address, or null when it is neither. */
function ipToBytes(ip: string): Uint8Array | null {
  if (IPV4_PATTERN.test(ip)) {
    const parts = ip.split(".").map(Number);
    return parts.every((n) => n >= 0 && n <= 255)
      ? Uint8Array.from(parts)
      : null;
  }
  return ipv6ToBytes(ip);
}

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const IPV6_GROUP_PATTERN = /^[0-9a-fA-F]{1,4}$/;
const CIDR_PREFIX_PATTERN = /^\d+$/;

/**
 * Expands an IPv6 address, including the `::` zero-compression form and the
 * `::ffff:1.2.3.4` IPv4-mapped form, into 16 bytes. Returns null for anything
 * that is not a well-formed address.
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  const mapped = ip.toLowerCase().match(IPV4_MAPPED_PATTERN);
  if (mapped?.[1]) {
    return ipToBytes(mapped[1]);
  }
  if (!ip.includes(":")) {
    return null;
  }
  const halves = ip.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) {
    return null;
  }
  const groups = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i];
    if (group === undefined || !IPV6_GROUP_PATTERN.test(group)) {
      return null;
    }
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

type CidrNetwork = { bytes: Uint8Array; prefix: number };

/**
 * Parses `IP` or `IP/prefix`. A malformed entry yields null and is dropped, so
 * a typo cannot silently widen the set of addresses treated as our own proxies.
 */
function parseCidr(entry: string): CidrNetwork | null {
  const slash = entry.lastIndexOf("/");
  const bytes = ipToBytes(slash === -1 ? entry : entry.slice(0, slash));
  if (!bytes) {
    return null;
  }
  const maxBits = bytes.length * 8;
  if (slash === -1) {
    return { bytes, prefix: maxBits };
  }
  const prefixPart = entry.slice(slash + 1);
  if (!CIDR_PREFIX_PATTERN.test(prefixPart)) {
    return null;
  }
  const prefix = Number(prefixPart);
  return prefix <= maxBits ? { bytes, prefix } : null;
}

function matchesCidr(ipBytes: Uint8Array, net: CidrNetwork): boolean {
  if (ipBytes.length !== net.bytes.length) {
    return false;
  }
  let bitsRemaining = net.prefix;
  for (let i = 0; i < ipBytes.length && bitsRemaining > 0; i++) {
    const take = bitsRemaining >= 8 ? 8 : bitsRemaining;
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if (((ipBytes[i] ?? 0) & mask) !== ((net.bytes[i] ?? 0) & mask)) {
      return false;
    }
    bitsRemaining -= 8;
  }
  return true;
}

const TRUSTED_PROXY_NETWORKS: readonly CidrNetwork[] =
  CLIENT_IP_TRUSTED_PROXIES.map(parseCidr).filter(
    (net): net is CidrNetwork => net !== null
  );
