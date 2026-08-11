import "server-only";

/**
 * Next.js-guarded entrypoint for Turnkey operations. Importing this file from
 * a client component throws at module load (the `server-only` package).
 *
 * Implementation lives in `./turnkey-operations` (no guard) so non-Next.js
 * callers like the deploy-time provisioning script can reuse the same logic.
 */
export {
  createTurnkeyWallet,
  exportTurnkeyPrivateKey,
  getTurnkeySignerConfig,
  type TurnkeyWalletResult,
} from "./turnkey-operations";
