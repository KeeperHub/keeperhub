/**
 * Pin the hosts of organization endpoints to the addresses the app vetted.
 *
 * @solana/web3.js opens its HTTP and WebSocket connections itself and takes no
 * lookup option, so the pin sits on `dns.lookup`, which Node's net reads on
 * every connect. A pinned host answers only with its vetted addresses; every
 * other host resolves as usual.
 */

import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { pinnedLookup } from "./pinned-lookup";

export type PinnedEndpoint = {
  url: string;
  addresses?: readonly string[];
};

type LookupOptions = Parameters<LookupFunction>[1];
type LookupCallback = Parameters<LookupFunction>[2];

const pins = new Map<string, LookupFunction>();
let installed = false;

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  const resolve = dns.lookup;
  const guarded = (
    hostname: string,
    options: unknown,
    callback?: unknown,
  ): void => {
    const pinned = pins.get(hostname.toLowerCase());
    if (!pinned) {
      (resolve as (...args: unknown[]) => void)(hostname, options, callback);
      return;
    }
    if (typeof options === "function") {
      pinned(hostname, {}, options as LookupCallback);
      return;
    }
    const lookupOptions: LookupOptions =
      typeof options === "number" ? { family: options } : (options ?? {});
    pinned(hostname, lookupOptions, callback as LookupCallback);
  };
  dns.lookup = guarded as typeof dns.lookup;
}

/** Replace the pinned hosts with those of the organization endpoints in use. */
export function pinEndpointHosts(endpoints: readonly PinnedEndpoint[]): void {
  install();
  pins.clear();
  for (const endpoint of endpoints) {
    if (endpoint.addresses) {
      pins.set(hostOf(endpoint.url), pinnedLookup(endpoint.addresses));
    }
  }
}
