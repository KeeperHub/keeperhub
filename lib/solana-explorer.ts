/**
 * Client-safe Solscan URL helpers.
 *
 * Solscan serves mainnet at the bare path and non-mainnet clusters via a
 * `?cluster=` query param. The only non-mainnet Solana chain we support is
 * devnet, so `isTestnet` maps to the devnet cluster.
 */
const SOLSCAN_BASE = "https://solscan.io";

export function solscanAccountUrl(address: string, isTestnet = false): string {
  const url = `${SOLSCAN_BASE}/account/${address}`;
  return isTestnet ? `${url}?cluster=devnet` : url;
}
