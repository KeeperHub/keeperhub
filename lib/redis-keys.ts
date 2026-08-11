/**
 * Central registry of Redis key builders. Keep key strings here, not inlined
 * at call sites, so namespaces can't drift.
 */

// Per-deployment namespace. staging and every PR env share one Redis instance,
// so keys are prefixed to keep them isolated. Not NODE_ENV: staging and PR
// envs are both "development". Set REDIS_KEY_PREFIX per deployment.
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? "local";

/** Joins `parts` into a Redis key under the per-deployment namespace. */
export function deploymentKey(...parts: string[]): string {
  return [KEY_PREFIX, ...parts].join(":");
}

/** Dedup claim for the new-device warning email, keyed on the device id. */
export function newDeviceNotifyClaimKey(
  userId: string,
  deviceId: string
): string {
  return deploymentKey("device-notify", userId, deviceId);
}

/**
 * Shared cache of a trusted (user, country). Present means the country gate
 * may pass without a DB read. `country` is the CF-attested 2-letter code.
 */
export function trustedCountryKey(userId: string, country: string): string {
  return deploymentKey("trust-country", userId, country);
}

/** Short-lived cache of a holder's native balance in wei, for the gas preflight. */
export function nativeBalanceKey(chainId: number, address: string): string {
  return deploymentKey("gas-balance", String(chainId), address.toLowerCase());
}

/** Short-lived cache of a chain's gas price in wei, for the gas preflight. */
export function gasPriceKey(chainId: number): string {
  return deploymentKey("gas-price", String(chainId));
}
