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
 * `createPublicOnlySocketFactory` is the matching connect-time check. Pass it
 * to the driver as its socket factory so the socket dials only addresses
 * that pass the same check, from the same DNS answer it connects to.
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

import type { LookupAddress, LookupOptions } from "node:dns";
import { promises as dns } from "node:dns";
import { isIP, connect as netConnect, type Socket } from "node:net";
import {
  HOST_NOT_ALLOWED_CODE,
  HOST_NOT_ALLOWED_MESSAGE,
} from "@/lib/db/connection-utils";
import { isBlockedHost, isBlockedIp } from "@/lib/safe-fetch";

/**
 * Reject connection attempts against private / loopback / link-local
 * destinations. Always-on (no env flag): there is no legitimate reason for
 * a user-supplied database host to resolve to a non-public address.
 *
 * This is the early check that gives a fast, clear error. The connection
 * itself must still go through `createPublicOnlySocketFactory`, which checks
 * the address the socket actually dials.
 */
export async function assertHostIsPublic(host: string): Promise<void> {
  const trimmed = host.trim();
  if (trimmed === "") {
    throw new Error("Host is required");
  }

  if (isBlockedHost(trimmed).blocked) {
    throw new Error(HOST_NOT_ALLOWED_MESSAGE);
  }

  if (isIP(trimmed) !== 0) {
    const verdict = isBlockedIp(trimmed);
    if (verdict.blocked) {
      throw new Error(HOST_NOT_ALLOWED_MESSAGE);
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
      throw new Error(HOST_NOT_ALLOWED_MESSAGE);
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

function hostNotAllowedError(): Error {
  return Object.assign(new Error(HOST_NOT_ALLOWED_MESSAGE), {
    code: HOST_NOT_ALLOWED_CODE,
  });
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * DNS lookup for the socket itself. Every resolved address must be public,
 * so the socket can only dial an address that passed the check.
 */
export function publicOnlyLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback
): void {
  dns.lookup(hostname, { ...options, all: true }).then(
    (addresses) => {
      const [first] = addresses;
      const blocked = addresses.some(
        ({ address }) => isBlockedIp(address).blocked
      );
      if (!first || blocked) {
        callback(hostNotAllowedError(), []);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      callback(null, first.address, first.family);
    },
    (error: NodeJS.ErrnoException) => {
      callback(error, []);
    }
  );
}

/**
 * Open a TCP socket to a user-supplied host, refusing any non-public
 * address. Resolves once the socket is connected; rejects with a
 * `HOST_NOT_ALLOWED` error, the underlying socket error, or a
 * `CONNECT_TIMEOUT` error after `timeoutMs`.
 */
export function connectToPublicHost(
  host: string | undefined,
  port: number | undefined,
  timeoutMs: number
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (!host || port === undefined) {
      reject(new Error("Connection string is missing a host"));
      return;
    }
    const bare =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const isLiteral = isIP(bare) !== 0;
    // An IP literal skips DNS, so it is checked here instead of in the lookup.
    const blocked = isLiteral
      ? isBlockedIp(bare).blocked
      : isBlockedHost(bare).blocked;
    if (blocked) {
      reject(hostNotAllowedError());
      return;
    }

    const socket = netConnect({ host: bare, port, lookup: publicOnlyLookup });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        Object.assign(new Error(`write CONNECT_TIMEOUT ${host}:${port}`), {
          code: "CONNECT_TIMEOUT",
        })
      );
    }, timeoutMs);
    const onError = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      // postgres.js reads socket.host for the TLS servername (SNI) and for
      // its own connection error messages.
      Object.assign(socket, { host, port });
      resolve(socket);
    });
  });
}

/** Target the driver passes to its socket factory (parsed host/port lists). */
export type SocketFactoryTarget = { host: string[]; port: number[] };

export type PublicOnlySocketFactory = (
  target: SocketFactoryTarget
) => Promise<Socket>;

/**
 * Socket factory for postgres.js (`socket` option). The driver then never
 * resolves or dials the host itself. Only the first host is used.
 */
export function createPublicOnlySocketFactory(
  connectTimeoutSeconds: number
): PublicOnlySocketFactory {
  return ({ host, port }) =>
    connectToPublicHost(host[0], port[0], connectTimeoutSeconds * 1000);
}

/**
 * Return postgres.js options with the public-only socket factory added,
 * using the same connect timeout. `socket` is a documented postgres.js
 * option that its type definitions omit, so it is added here rather than
 * in the caller's object literal.
 */
export function withPublicOnlySocket<T extends { connect_timeout: number }>(
  options: T
): T {
  return {
    ...options,
    socket: createPublicOnlySocketFactory(options.connect_timeout),
  };
}
