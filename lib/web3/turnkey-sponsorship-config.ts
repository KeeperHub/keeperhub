import "server-only";
import { SPONSORSHIP_CHAIN_IDS } from "./sponsorship-chains-meta";

/**
 * Chain IDs where gas sponsorship via Turnkey's native Transaction Management
 * (Gas Station) is supported. Turnkey signs AND sponsors the underlying
 * EVM transaction in a single API call -- there is no ERC-4337 bundler or
 * paymaster involved.
 *
 * Derived from the shared sponsorship chain metadata so the runtime allowlist
 * and the billing UI cannot drift. Turnkey covers four mainnets (Ethereum,
 * Base, Polygon, Arbitrum) and their canonical testnets; Optimism and BNB are
 * absent from the Gas Station. The SDK v5.2.0 CAIP-2 enum lags Turnkey's
 * actual coverage and does not yet list `eip155:42161`, so `toCaip2` widens
 * the type at the call site in `turnkey-sponsored-tx.ts` until the SDK
 * regenerates.
 */
export const SUPPORTED_SPONSORSHIP_CHAINS: ReadonlySet<number> =
  SPONSORSHIP_CHAIN_IDS;

export function isSponsorshipSupported(chainId: number): boolean {
  return SUPPORTED_SPONSORSHIP_CHAINS.has(chainId);
}

/**
 * Map an EVM chain ID to the CAIP-2 identifier Turnkey expects on
 * `ethSendTransaction.parameters.caip2`. Returns null for unsupported
 * chains so callers can fall back to direct signing.
 */
export function toCaip2(chainId: number): string | null {
  if (!isSponsorshipSupported(chainId)) {
    return null;
  }
  return `eip155:${chainId}`;
}
