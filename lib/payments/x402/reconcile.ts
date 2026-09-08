import { Contract, JsonRpcProvider } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { railForProtocol } from "@/lib/payments/rails";

const X402_RAIL = railForProtocol("x402");

const AUTH_STATE_ABI = [
  "function authorizationState(address, bytes32) view returns (uint8)",
];

const TIMEOUT_PATTERNS = [
  "context deadline exceeded",
  "did not confirm in time",
  "unable to estimate gas",
];

// Module-level singleton: avoid creating a new provider (and its connection
// pool) on every reconciliation call. Mirrors the pattern used in
// lib/x402/server.ts. BASE_RPC_URL is read once at module load.
const provider = new JsonRpcProvider(
  process.env[X402_RAIL.rpcUrlEnvVar] ?? X402_RAIL.defaultRpcUrl
);
const settlementAsset = new Contract(X402_RAIL.asset, AUTH_STATE_ABI, provider);

/**
 * Returns true if the error message indicates a transient facilitator timeout
 * that may have resulted in a submitted-but-unconfirmed on-chain transaction.
 * Returns false for permanent failures (invalid_payload, insufficient balance, etc.).
 */
export function isTimeoutError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return TIMEOUT_PATTERNS.some((pattern) => lower.includes(pattern));
}

type PollOptions = {
  payerAddress: string;
  nonce: string;
  maxWaitMs?: number;
  intervalMs?: number;
};

/**
 * Polls the USDC EIP-3009 authorizationState on Base mainnet to determine
 * whether a payment nonce has been used on-chain.
 *
 * Used for facilitator timeout reconciliation: when the CDP facilitator times
 * out, the transaction may already be submitted. This polls until the nonce is
 * confirmed used (state=1) or the deadline is exceeded.
 *
 * Returns:
 *   true  -- nonce is used (state 1); payment settled on-chain
 *   false -- nonce unused after maxWaitMs, or nonce is cancelled (state 2)
 */
export async function pollForPaymentConfirmation({
  payerAddress,
  nonce,
  maxWaitMs = 120_000,
  intervalMs = 5000,
}: PollOptions): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const state = (await settlementAsset.authorizationState(
        payerAddress,
        nonce
      )) as bigint;

      if (state === BigInt(1)) {
        return true;
      }

      if (state === BigInt(2)) {
        // Cancelled -- no point waiting further
        return false;
      }
    } catch (err) {
      // Transient RPC errors should not abort reconciliation
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[x402/reconcile] RPC error during polling, continuing",
        err
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}
