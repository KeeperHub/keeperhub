/**
 * Guard that keeps destructive dev and backfill scripts off a database that
 * is not local.
 *
 * Seven scripts carried their own copy of the host allowlist under two names
 * (ALLOWED_HOSTS, LOCAL_HOSTS), as both a Set and an array, in two orderings,
 * behind three differently-shaped guards. The isLocalDb copies stripped the
 * brackets URL.hostname keeps around an IPv6 literal; the assertLocalDb copies
 * did not, so "::1" sat in their allowlist and could never match it.
 */

const IPV6_BRACKETS = /^\[|\]$/g;

export const LOCAL_DB_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "db",
  "postgres",
]);

/** URL.hostname keeps the brackets around an IPv6 literal; the allowlist does not. */
function hostnameOf(url: string): string {
  return new URL(url).hostname.replace(IPV6_BRACKETS, "");
}

export function isLocalDb(
  url: string | undefined = process.env.DATABASE_URL
): boolean {
  try {
    return LOCAL_DB_HOSTS.has(hostnameOf(url ?? ""));
  } catch {
    return false;
  }
}

/** Throws unless the URL points at a local database. Returns the hostname. */
export function assertLocalDb(url: string, scriptName: string): string {
  let hostname: string;
  try {
    hostname = hostnameOf(url);
  } catch {
    throw new Error(
      `${scriptName}: DATABASE_URL is not a parseable URL: ${url}`
    );
  }
  if (!LOCAL_DB_HOSTS.has(hostname)) {
    throw new Error(
      `${scriptName}: refusing to run against host "${hostname}". ` +
        `Only ${[...LOCAL_DB_HOSTS].join(", ")} are allowed. ` +
        "Set DATABASE_URL to a local Postgres before re-running."
    );
  }
  return hostname;
}
