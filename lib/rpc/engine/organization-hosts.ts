import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Hosts of organization RPC endpoints. Providers put API keys in subdomains,
 * so these hosts are never written to logs or shown in error text.
 *
 * Hosts of saved configs are kept for the process; there are only as many as
 * configs. A URL that is still being checked before save is covered only for
 * the duration of its check, so checking arbitrary hosts cannot mark them.
 */
const savedHosts = new Set<string>();
const checkingUrl = new AsyncLocalStorage<true>();

const IPV6_BRACKETS = /^\[|\]$/g;

function normalized(hostname: string): string {
  return hostname.replace(IPV6_BRACKETS, "").toLowerCase();
}

export function markOrganizationHost(hostname: string): void {
  savedHosts.add(normalized(hostname));
}

/** Run a pre-save check of an organization URL. */
export function runCheckingOrganizationUrl<T>(check: () => T): T {
  return checkingUrl.run(true, check);
}

export function isOrganizationHost(hostname: string): boolean {
  return (
    checkingUrl.getStore() === true || savedHosts.has(normalized(hostname))
  );
}
