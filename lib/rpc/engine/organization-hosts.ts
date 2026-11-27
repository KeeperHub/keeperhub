/**
 * Hosts of organization RPC endpoints. Providers put API keys in subdomains,
 * so these hosts are never written to logs or shown in error text.
 *
 * Hosts of saved configs are kept for the process; there are only as many as
 * configs. Free of Node modules, since error code that runs inside workflow
 * functions reads it.
 */
const savedHosts = new Set<string>();

const IPV6_BRACKETS = /^\[|\]$/g;

function normalized(hostname: string): string {
  return hostname.replace(IPV6_BRACKETS, "").toLowerCase();
}

export function markOrganizationHost(hostname: string): void {
  savedHosts.add(normalized(hostname));
}

export function isSavedOrganizationHost(hostname: string): boolean {
  return savedHosts.has(normalized(hostname));
}

const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;
export const ORGANIZATION_HOST_PLACEHOLDER = "[organization host]";

/** Replace every saved organization host named in `text`. */
export function redactOrganizationHosts(text: string): string {
  if (savedHosts.size === 0 || !text) {
    return text;
  }
  return text.replace(HOSTNAME_RE, (host) =>
    savedHosts.has(normalized(host)) ? ORGANIZATION_HOST_PLACEHOLDER : host
  );
}
