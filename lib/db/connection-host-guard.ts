/**
 * SSRF guards for non-HTTP outbound connections to user-supplied hosts
 * (Postgres today). The HTTP path uses `safeFetch` from `lib/safe-fetch.ts`;
 * this module reuses the same lookup and connect checks for raw sockets, so
 * there is one copy of the SSRF logic.
 *
 * - `assertSinglePostgresHost` is a parse-only check that runs before a
 *   client is built. It reads the host the way postgres.js does and rejects
 *   a connection string with more than one host.
 * - `withPublicOnlySocket` gives postgres.js a socket factory. The socket
 *   resolves the host through `validatingLookup`, so every address it may
 *   dial is checked on the same DNS answer it connects to.
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

import {
  type LookupFunction,
  connect as netConnect,
  type Socket,
} from "node:net";
import { HOST_NOT_ALLOWED_MESSAGE } from "@/lib/db/connection-utils";
import { logSecurityEvent } from "@/lib/logging";
import {
  checkConnectTarget,
  runWithSafeFetchPlugin,
  SsrfBlockedError,
  stripIpv6Brackets,
  validatingLookup,
} from "@/lib/safe-fetch";

const MISSING_HOST_MESSAGE = "Connection string is missing a host";

// postgres.js ends the authority at the first `/` or `?`.
const AUTHORITY_END = /[?/]/;

/**
 * Parse-only check, run before a client is built. Reads the host part of the
 * connection string exactly as postgres.js 3.x does in `parseUrl` (the
 * authority up to the first `/` or `?`, the part after the first `@`,
 * percent-decoded) and rejects it when it names more than one host. The
 * socket factory dials only one host, and postgres.js leaves a query pending
 * forever when the factory refuses the first of several hosts.
 *
 * Throws on:
 * - more than one host (`Error("Host is not allowed: must resolve to a public address")`)
 * - a missing or unparseable host (`Error("Connection string is missing a host")`)
 *
 * Error messages never echo the input URL.
 */
export function assertSinglePostgresHost(url: string): void {
  let host: string;
  try {
    const authority =
      url.slice(url.indexOf("://") + 3).split(AUTHORITY_END)[0] ?? "";
    host = decodeURIComponent(authority.slice(authority.indexOf("@") + 1));
  } catch {
    throw new Error(MISSING_HOST_MESSAGE);
  }
  // postgres.js builds a URL from the first host; mirror its parse failure.
  if (
    host === "" ||
    !URL.canParse(url.replace(host, host.split(",")[0] ?? ""))
  ) {
    throw new Error(MISSING_HOST_MESSAGE);
  }
  if (host.includes(",")) {
    throw new Error(HOST_NOT_ALLOWED_MESSAGE);
  }
}

function recordBlockedConnection(
  error: SsrfBlockedError,
  plugin: string
): void {
  logSecurityEvent("ssrf_connection_blocked", {
    plugin,
    hostname: error.hostname,
    resolved_ip: error.resolvedIp,
    reason: error.reason,
  });
}

function blockRecordingLookup(plugin: string): LookupFunction {
  return (hostname, options, callback) => {
    validatingLookup(hostname, options, (error, address, family) => {
      if (error instanceof SsrfBlockedError) {
        recordBlockedConnection(error, plugin);
      }
      callback(error, address, family);
    });
  };
}

function ignoreSocketError(): void {
  // The caller attaches its own error listener once the factory returns.
}

/** Target postgres.js passes to its socket factory (parsed host/port lists). */
export type SocketFactoryTarget = { host: string[]; port: number[] };

export type PublicOnlySocketFactory = (
  target: SocketFactoryTarget
) => Promise<Socket>;

/**
 * Socket factory for postgres.js (`socket` option). The driver then never
 * resolves or dials the host itself.
 *
 * The socket is returned while it is still connecting, so the driver's own
 * `connect_timeout` covers DNS, TCP, TLS and startup as one budget. Blocks
 * are recorded under `plugin` in the safe-fetch block metric and as a
 * security event. Only the first host is dialled, which is why callers run
 * `assertSinglePostgresHost` first.
 */
export function createPublicOnlySocketFactory(
  plugin: string
): PublicOnlySocketFactory {
  const lookup = blockRecordingLookup(plugin);
  return ({ host, port }) =>
    runWithSafeFetchPlugin(plugin, () => {
      const [rawHost] = host;
      const [rawPort] = port;
      if (!rawHost || rawPort === undefined) {
        return Promise.reject(new Error(MISSING_HOST_MESSAGE));
      }
      const target = stripIpv6Brackets(rawHost);
      const blockError = checkConnectTarget(target);
      if (blockError) {
        recordBlockedConnection(blockError, plugin);
        return Promise.reject(blockError);
      }
      const socket = netConnect({ host: target, port: rawPort, lookup });
      // Keep a listener attached until the driver has taken over the socket.
      socket.on("error", ignoreSocketError);
      // postgres.js reads socket.host for the TLS servername (SNI) and for
      // its own connection error messages.
      Object.assign(socket, { host: rawHost, port: rawPort });
      return Promise.resolve(socket);
    });
}

/**
 * Return postgres.js options with the public-only socket factory added.
 * `socket` is a documented postgres.js option that its type definitions
 * omit, so it is added here rather than in the caller's object literal; the
 * return type keeps it visible to the type system.
 */
export function withPublicOnlySocket<T extends object>(
  options: T,
  plugin: string
): T & { socket: PublicOnlySocketFactory } {
  return { ...options, socket: createPublicOnlySocketFactory(plugin) };
}
