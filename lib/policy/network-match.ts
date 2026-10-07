/**
 * Network matching for policy conditions, with no external dependency.
 *
 * Both matchers are deliberately strict: a value they cannot parse does not
 * match, so a malformed rule or an unreadable fact refuses rather than quietly
 * letting something through.
 *
 * Addresses are held as arrays of 16-bit groups rather than as one integer, so
 * IPv4 and IPv6 share one comparison and nothing depends on a numeric width.
 */

import {
  SSRF_IPV4_BROADCAST_ADDRESSES,
  SSRF_IPV4_CIDRS,
  SSRF_IPV6_CIDRS,
  SSRF_IPV6_LITERAL_ADDRESSES,
  SSRF_NAT64_PREFIX_CIDR,
} from "@/lib/ssrf-blocklist";

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP_PATTERN = /^[0-9a-f]{1,4}$/;
const TRAILING_DOT = /\.$/;

const IPV4_GROUPS = 2;
const IPV6_GROUPS = 8;
const GROUP_BITS = 16;

type ParsedIp = {
  /** 16-bit groups, most significant first. */
  groups: number[];
  bits: number;
};

function parseIpv4(ip: string): ParsedIp | null {
  const match = IPV4_PATTERN.exec(ip.trim());
  if (!match) {
    return null;
  }
  const octets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return {
    groups: [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]],
    bits: IPV4_GROUPS * GROUP_BITS,
  };
}

const IPV4_MAPPED_PREFIX_GROUPS = 5;
const IPV4_MAPPED_MARKER = 0xff_ff;

/**
 * Collapse an IPv4-mapped IPv6 address to its IPv4 form.
 *
 * `::ffff:169.254.169.254` and `169.254.169.254` are the same destination, so a
 * rule naming one must catch the other. Leaving them distinct is a live SSRF
 * bypass rather than a cosmetic gap: a `deny` that fails to match does not
 * fire, so the mapped form would sail past a rule written against the plain
 * one.
 */
function unmapIpv4(parsed: ParsedIp): ParsedIp {
  if (parsed.groups.length !== IPV6_GROUPS) {
    return parsed;
  }
  const prefixIsZero = parsed.groups
    .slice(0, IPV4_MAPPED_PREFIX_GROUPS)
    .every((group) => group === 0);
  if (!(prefixIsZero && parsed.groups[5] === IPV4_MAPPED_MARKER)) {
    return parsed;
  }
  return {
    groups: [parsed.groups[6], parsed.groups[7]],
    bits: IPV4_GROUPS * GROUP_BITS,
  };
}

/** Expands the `::` shorthand into its full set of groups. */
function parseIpv6(ip: string): ParsedIp | null {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed.includes(":")) {
    return null;
  }
  const halves = trimmed.split("::");
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // A dotted quad occupies two groups, so it counts twice when working out how
  // many zero groups the `::` stands in for.
  const width = (parts: string[]): number =>
    parts.reduce((total, part) => total + (part.includes(".") ? 2 : 1), 0);
  const missing = IPV6_GROUPS - width(head) - width(tail);
  if (halves.length === 2 ? missing < 0 : missing !== 0) {
    return null;
  }

  const parts = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...tail,
  ];

  const groups: number[] = [];
  for (const part of parts) {
    // A trailing dotted quad is legal in IPv6 and is how a mapped address is
    // usually written, so it expands into the two groups it encodes.
    const embedded = parseIpv4(part);
    if (embedded) {
      groups.push(...embedded.groups);
      continue;
    }
    if (!IPV6_GROUP_PATTERN.test(part)) {
      return null;
    }
    groups.push(Number.parseInt(part, 16));
  }
  if (groups.length !== IPV6_GROUPS) {
    return null;
  }
  return { groups, bits: IPV6_GROUPS * GROUP_BITS };
}

function parseIp(ip: string): ParsedIp | null {
  const v4 = parseIpv4(ip);
  if (v4) {
    return v4;
  }
  const v6 = parseIpv6(ip);
  return v6 ? unmapIpv4(v6) : null;
}

/** Whether two addresses agree on their first `prefix` bits. */
function sharePrefix(a: ParsedIp, b: ParsedIp, prefix: number): boolean {
  let remaining = prefix;
  for (let i = 0; i < a.groups.length && remaining > 0; i++) {
    const take = Math.min(GROUP_BITS, remaining);
    const shift = GROUP_BITS - take;
    if (a.groups[i] >>> shift !== b.groups[i] >>> shift) {
      return false;
    }
    remaining -= take;
  }
  return true;
}

/**
 * Whether an IP falls inside a CIDR range.
 *
 * A bare address with no prefix is treated as a single-host range, so an
 * allowlist can mix "10.0.0.0/8" and "203.0.113.7" without special handling.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const address = parseIp(ip);
  if (!address) {
    return false;
  }

  const [rangePart, prefixPart] = cidr.trim().split("/");
  const range = parseIp(rangePart ?? "");
  if (!range || range.bits !== address.bits) {
    return false;
  }

  const prefix = prefixPart === undefined ? range.bits : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > range.bits) {
    return false;
  }

  return sharePrefix(address, range, prefix);
}

/** Whether an IP falls inside any range in the list. */
export function ipInAnyCidr(ip: string, ranges: readonly string[]): boolean {
  return ranges.some((range) =>
    range.trim() === INTERNAL_ADDRESS_TOKEN
      ? isInternalAddress(ip)
      : ipInCidr(ip, range)
  );
}

const WILDCARD_PREFIX = "*.";

/**
 * Whether a host matches a domain pattern.
 *
 * "*.example.com" covers any subdomain but not the bare domain, which is the
 * behaviour certificates and firewalls use; write both entries when both are
 * meant. Matching ignores case and a trailing dot.
 */
export function hostMatchesDomain(host: string, pattern: string): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(TRAILING_DOT, "");
  const normalizedPattern = pattern
    .trim()
    .toLowerCase()
    .replace(TRAILING_DOT, "");
  if (normalizedHost.length === 0 || normalizedPattern.length === 0) {
    return false;
  }
  if (normalizedPattern.startsWith(WILDCARD_PREFIX)) {
    const bare = normalizedPattern.slice(WILDCARD_PREFIX.length);
    return normalizedHost.endsWith(`.${bare}`);
  }
  return normalizedHost === normalizedPattern;
}

/** Whether a host matches any pattern in the list. */
export function hostMatchesAnyDomain(
  host: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) => hostMatchesDomain(host, pattern));
}

/**
 * Token standing for every address the platform already refuses to reach.
 *
 * Writing the ranges out by hand in each policy would fork the blocklist: an
 * organization's rule would keep whatever was true the day it was written,
 * while the fetch layer moved on. The token resolves against
 * `lib/ssrf-blocklist.json`, so both read the same source.
 */
export const INTERNAL_ADDRESS_TOKEN = "@internal";

/**
 * Whether an address is loopback, private, link-local, or otherwise internal.
 *
 * Includes 169.254.0.0/16, which holds the cloud metadata endpoint, and
 * resolves IPv4-mapped IPv6 first so the mapped form cannot slip past.
 */
export function isInternalAddress(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) {
    // An address we cannot parse is treated as internal, so a deny fires on it
    // rather than letting an unreadable value through.
    return true;
  }

  const literals =
    parsed.bits === IPV4_GROUPS * GROUP_BITS
      ? SSRF_IPV4_BROADCAST_ADDRESSES
      : SSRF_IPV6_LITERAL_ADDRESSES;
  if (literals.some((literal) => sameAddress(parsed, literal))) {
    return true;
  }

  const cidrs =
    parsed.bits === IPV4_GROUPS * GROUP_BITS
      ? SSRF_IPV4_CIDRS
      : SSRF_IPV6_CIDRS;
  if (cidrs.some(([address, prefix]) => ipInCidr(ip, `${address}/${prefix}`))) {
    return true;
  }

  // NAT64 encodes an IPv4 destination in its low 32 bits, so the embedded
  // address is rechecked rather than the wrapper being judged on its own.
  const [nat64Address, nat64Prefix] = SSRF_NAT64_PREFIX_CIDR;
  if (ipInCidr(ip, `${nat64Address}/${nat64Prefix}`)) {
    return true;
  }

  return false;
}

function sameAddress(parsed: ParsedIp, literal: string): boolean {
  const other = parseIp(literal);
  return (
    other !== null &&
    other.bits === parsed.bits &&
    other.groups.every((group, index) => group === parsed.groups[index])
  );
}
