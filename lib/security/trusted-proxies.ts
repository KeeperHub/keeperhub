/**
 * Trusted-proxy XFF resolver. Returns the real client IP if the request
 * arrived via a trusted proxy (Cloudflare or internal LB); otherwise returns
 * the connecting peer IP and ignores the X-Forwarded-For header.
 *
 * Why: agents can spoof X-Forwarded-For freely. The header is only meaningful
 * if the request demonstrably came from a known proxy.
 *
 * IPv4-only. IPv6 peers (including Cloudflare's IPv6 ranges, e.g.
 * 2606:4700::/32) are treated as untrusted — XFF is ignored and the
 * connecting IP is used. Add IPv6 CIDR support when v6 traffic warrants it.
 */

// Snapshot of Cloudflare IPv4 ranges (refresh from
// https://www.cloudflare.com/ips/ and replace this list when Cloudflare
// updates its public range list — typically every 6-12 months).
const TRUSTED_PROXY_CIDRS_V4: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    result = (result << 8) + n;
  }
  return result >>> 0;
}

function cidrMask(prefix: number): number {
  // 32-bit unsigned mask with the top `prefix` bits set. Caller guarantees
  // prefix is in [1, 32]; prefix === 0 is a "match anything" short-circuit
  // handled before we get here.
  return (0xff_ff_ff_ff << (32 - prefix)) >>> 0;
}

function isInCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  if (!(base && prefixStr)) {
    return false;
  }
  const prefix = Number.parseInt(prefixStr, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const baseInt = ipToInt(base);
  const ipInt = ipToInt(ip);
  if (baseInt === null || ipInt === null) {
    return false;
  }
  if (prefix === 0) {
    return true;
  }
  const mask = cidrMask(prefix);
  return (baseInt & mask) === (ipInt & mask);
}

function isTrustedProxy(ip: string): boolean {
  for (const cidr of TRUSTED_PROXY_CIDRS_V4) {
    if (isInCidr(ip, cidr)) {
      return true;
    }
  }
  return false;
}

export function resolveTrustedClientIp(
  request: Request,
  connectingIp: string | null
): string {
  if (!connectingIp) {
    return "unknown";
  }
  if (!isTrustedProxy(connectingIp)) {
    return connectingIp;
  }
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) {
    return connectingIp;
  }
  const leftmost = xff.split(",")[0]?.trim();
  return leftmost && leftmost.length > 0 ? leftmost : connectingIp;
}
