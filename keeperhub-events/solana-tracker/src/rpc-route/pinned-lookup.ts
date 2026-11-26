/**
 * Connect an organization's endpoint only to the addresses the app vetted.
 *
 * The app resolves an organization endpoint's host, checks every address is
 * public, and sends those addresses with the route. Dialling through this
 * lookup means no DNS answer given after that check, such as one re-pointing
 * the host at an internal address, can change where the socket goes.
 *
 * Kept identical in keeperhub-events/event-tracker, keeperhub-events/
 * solana-tracker and keeperhub-scheduler; a test in the app checks the copies.
 */

import { type LookupFunction, isIP } from "node:net";

export class NoVettedAddressError extends Error {
  constructor() {
    super("No vetted address for this endpoint");
    this.name = "NoVettedAddressError";
  }
}

/** True for a list that is non-empty and holds only IP literals. */
export function isAddressList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && isIP(item) !== 0)
  );
}

/** A DNS lookup that answers only with `addresses`, whatever the host. */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const entries = addresses.map((address) => ({
      address,
      family: isIP(address),
    }));
    const [first] = entries;
    if (!first) {
      callback(new NoVettedAddressError(), "", 0);
      return;
    }
    if (options.all) {
      callback(null, entries);
      return;
    }
    callback(null, first.address, first.family);
  };
}
