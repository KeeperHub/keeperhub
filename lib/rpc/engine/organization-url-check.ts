import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { isSavedOrganizationHost } from "./organization-hosts";

/**
 * A URL still being checked before save is treated as an organization
 * host only for the duration of its check, so checking arbitrary hosts
 * cannot mark them.
 */
const checkingUrl = new AsyncLocalStorage<true>();

/** Run a pre-save check of an organization URL. */
export function runCheckingOrganizationUrl<T>(check: () => T): T {
  return checkingUrl.run(true, check);
}

/** A saved organization host, or any host while a check is running. */
export function isOrganizationHost(hostname: string): boolean {
  return checkingUrl.getStore() === true || isSavedOrganizationHost(hostname);
}
