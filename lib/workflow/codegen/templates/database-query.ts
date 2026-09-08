/**
 * Code template for Database Query action step
 * This is a string template used for code generation - keep as string export
 *
 * Requires: pnpm add postgres
 * Environment: DATABASE_URL
 *
 * SSRF data: the embedded blocklist is interpolated from
 * `lib/ssrf-blocklist.json` (the same canonical source consumed by
 * `lib/safe-fetch.ts` and `lib/db/connection-host-guard.ts`) at module
 * load time, so any future update to the JSON propagates to exported
 * workflows on the next export. Re-exporting the workflow is required to
 * pick up upstream changes; previously exported code carries a snapshot.
 *
 * The body of databaseQueryStep is extracted by the SDK code generator's
 * function-body regex; all guard logic and helpers therefore live INSIDE
 * the main function (as local `const` arrows) so they survive extraction.
 *
 * NAT64 well-known prefix and IPv4-mapped-IPv6 special-cases from the
 * canonical guard are intentionally omitted here: they require non-trivial
 * extraction logic and only matter on dual-stack networks. The standard
 * CIDR / hostname checks below cover the documented threat (cloud
 * metadata, RFC1918, link-local, cluster-internal DNS).
 */
import blocklist from "@/lib/ssrf-blocklist.json" with { type: "json" };

const BLOCKLIST_LITERAL = JSON.stringify(blocklist);

export default `export async function databaseQueryStep(input: {
  query: string;
}) {
  "use step";

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { success: false, error: "DATABASE_URL environment variable is not set" };
  }

  // SSRF blocklist mirrored from KeeperHub's lib/ssrf-blocklist.json at
  // export time. Single source of truth lives in the KeeperHub repo;
  // re-export the workflow to refresh.
  const SSRF_BLOCKLIST = ${BLOCKLIST_LITERAL} as {
    ipv4Cidrs: [string, number][];
    ipv4BroadcastAddresses: string[];
    ipv6Cidrs: [string, number][];
    ipv6LiteralAddresses: string[];
    blockedHostExact: string[];
    blockedHostSuffixes: string[];
  };

  const { BlockList, isIP } = await import("node:net");
  const blockList = new BlockList();
  for (const [addr, prefix] of SSRF_BLOCKLIST.ipv4Cidrs) {
    blockList.addSubnet(addr, prefix, "ipv4");
  }
  for (const addr of SSRF_BLOCKLIST.ipv4BroadcastAddresses) {
    blockList.addAddress(addr, "ipv4");
  }
  for (const [addr, prefix] of SSRF_BLOCKLIST.ipv6Cidrs) {
    blockList.addSubnet(addr, prefix, "ipv6");
  }
  for (const addr of SSRF_BLOCKLIST.ipv6LiteralAddresses) {
    blockList.addAddress(addr, "ipv6");
  }

  const isBlockedHostname = (h: string): boolean => {
    let normalised = h.trim().toLowerCase();
    if (normalised.endsWith(".")) {
      normalised = normalised.slice(0, -1);
    }
    if (normalised === "") return false;
    if (SSRF_BLOCKLIST.blockedHostExact.includes(normalised)) return true;
    for (const suffix of SSRF_BLOCKLIST.blockedHostSuffixes) {
      if (normalised.endsWith(suffix)) return true;
    }
    return false;
  };

  const isBlockedIp = (ip: string): boolean => {
    const fam = isIP(ip);
    if (fam === 4) return blockList.check(ip, "ipv4");
    if (fam === 6) return blockList.check(ip, "ipv6");
    return false;
  };

  let parsedHost: string;
  try {
    parsedHost = new URL(databaseUrl).hostname;
  } catch {
    return { success: false, error: "Connection string is missing a host" };
  }
  if (!parsedHost) {
    return { success: false, error: "Connection string is missing a host" };
  }
  const host =
    parsedHost.startsWith("[") && parsedHost.endsWith("]")
      ? parsedHost.slice(1, -1)
      : parsedHost;

  if (isBlockedHostname(host)) {
    return { success: false, error: "Host is not allowed: must resolve to a public address" };
  }
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      return { success: false, error: "Host is not allowed: must resolve to a public address" };
    }
  } else {
    const dnsModule = await import("node:dns");
    let addresses: Array<{ address: string }>;
    try {
      addresses = await dnsModule.promises.lookup(host, { all: true });
    } catch {
      return { success: false, error: "Host could not be resolved" };
    }
    for (const addr of addresses) {
      if (isBlockedIp(addr.address)) {
        return { success: false, error: "Host is not allowed: must resolve to a public address" };
      }
    }
  }

  const postgres = await import("postgres");
  const sql = postgres.default(databaseUrl, { max: 1 });

  try {
    const result = await sql.unsafe(input.query);
    await sql.end();
    return { success: true, rows: result, count: result.length };
  } catch (error) {
    await sql.end();
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: \`Database query failed: \${message}\` };
  }
}`;
