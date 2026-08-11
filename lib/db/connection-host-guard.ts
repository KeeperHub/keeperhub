/**
 * SSRF guards for non-HTTP outbound connections (Postgres today; MongoDB,
 * Redis, SMTP, etc. in future). The HTTP path uses `safeFetch` /
 * `assertUrlIsPublic` from `lib/safe-fetch.ts`; this module is the single
 * source of truth for everything else that opens a socket to a
 * user-supplied host.
 *
 * `assertConnectionUrlIsPublic` is the call any such plugin should make
 * before it hands a connection string to its driver. It composes URL
 * parsing, IPv6-bracket stripping, and the underlying `assertHostIsPublic`
 * check, so a plugin needs exactly one import and one call.
 *
 * Lives in its own module (rather than connection-utils.ts) because it
 * pulls in `lib/safe-fetch.ts`, which has `import "server-only"`.
 * `drizzle.config.ts` imports `getDatabaseUrl` from connection-utils at
 * CLI time (drizzle-kit, migrations, CI setup-db), and any transitive
 * `server-only` import there blows up the config load with "This module
 * cannot be imported from a Client Component module."
 *
 * Keeping the guard isolated lets `connection-utils.ts` stay
 * import-clean for tooling that runs outside Next's server runtime.
 */
import "server-only";

import type { LookupAddress } from "node:dns";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { isBlockedHost, isBlockedIp } from "@/lib/safe-fetch";

/**
 * Reject connection-test attempts against private / loopback / link-local
 * destinations. Used by the integration-test endpoint, which dials a
 * user-supplied host over raw TCP via the `postgres` package, a path that
 * does not go through `safe-fetch.ts` (HTTP-only). Always-on (no env
 * flag): there is no legitimate reason for an `/api/integrations/test`
 * request to resolve to a non-public address.
 *
 * Caveat: there is a small TOCTOU window between this DNS check and the
 * subsequent TCP connect during which an attacker-controlled domain
 * could rebind. Closing that window requires resolving once and
 * dialling the resolved IP directly, which is out of scope for this
 * fix (would mean rewriting how the postgres client is invoked). The
 * TOCTOU surface for postgres TCP is much narrower than HTTP DNS
 * rebinding (no scriptable client behind the connection), so we accept
 * it here.
 */
export async function assertHostIsPublic(host: string): Promise<void> {
  const trimmed = host.trim();
  if (trimmed === "") {
    throw new Error("Host is required");
  }

  if (isBlockedHost(trimmed).blocked) {
    throw new Error("Host is not allowed: must resolve to a public address");
  }

  if (isIP(trimmed) !== 0) {
    const verdict = isBlockedIp(trimmed);
    if (verdict.blocked) {
      throw new Error("Host is not allowed: must resolve to a public address");
    }
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(trimmed, { all: true });
  } catch {
    throw new Error("Host could not be resolved");
  }

  for (const addr of addresses) {
    const verdict = isBlockedIp(addr.address);
    if (verdict.blocked) {
      throw new Error("Host is not allowed: must resolve to a public address");
    }
  }
}

/**
 * Extract the hostname from a postgres connection URL.
 *
 * Returns null if the URL is malformed; callers should treat that as a
 * validation failure.
 */
export function extractHostFromConnectionString(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The single source of truth for "is this connection string allowed to be
 * dialled?" for non-HTTP outbound plugins.
 *
 * Composes URL parsing, IPv6-bracket stripping, and the underlying
 * `assertHostIsPublic` check. Plugins that take a user-supplied connection
 * string (Postgres today; MongoDB, Redis, SMTP, raw TCP, anything that
 * opens a socket to a user-controlled host) should call this once at the
 * top of their step, before constructing any client.
 *
 * Throws on:
 * - missing or unparseable host (`Error("Connection string is missing a host")`)
 * - blocked hostname pattern, blocked IP, or DNS that resolves to one
 *   (`Error("Host is not allowed: must resolve to a public address")`)
 * - DNS failure (`Error("Host could not be resolved")`)
 *
 * Error messages never echo the input URL, so they are safe to surface
 * to the workflow caller. Plugins that already strip secrets from
 * connection strings before logging do not need any additional sanitisation
 * for errors raised here.
 */
export async function assertConnectionUrlIsPublic(url: string): Promise<void> {
  const host = extractHostFromConnectionString(url);
  if (!host) {
    throw new Error("Connection string is missing a host");
  }
  const stripped =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  await assertHostIsPublic(stripped);
}
