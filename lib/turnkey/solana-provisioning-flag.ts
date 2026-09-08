/**
 * Gates Solana wallet provisioning.
 *
 * When this is not explicitly enabled, Turnkey sub-orgs are created EVM-only
 * and the backfill script is a no-op, so the wallet feature can ship before a
 * Solana RPC is configured via CHAIN_RPC_CONFIG. Defaults to OFF: set
 * `SOLANA_WALLET_PROVISIONING_ENABLED=true` to provision Solana accounts.
 *
 * Intentionally dependency-free so the standalone backfill script (run via tsx,
 * outside the app's server-only import chain) can import it.
 */
export function isSolanaWalletProvisioningEnabled(): boolean {
  return process.env.SOLANA_WALLET_PROVISIONING_ENABLED === "true";
}
