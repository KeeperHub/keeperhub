import "server-only";

import { classifyRevert } from "@/lib/web3/decode-revert-error";

/**
 * Friendly translation of Safe-deploy / Safe-write failures so the UI can
 * surface something the user can act on. The raw ethers `CALL_EXCEPTION`
 * payload (1KB+ of address/data/reason JSON) is unreadable in a toast; we
 * route it through `classifyRevert` and map the known kinds.
 *
 * Returns:
 * - `message`: short user-facing string for `toast.error`
 * - `kind`: stable discriminator for clients that want to branch
 *
 * Fallback is the original error's message, prefixed so it's recognisable
 * as a Safe-deploy failure rather than a generic 500.
 */
export type SafeDeployErrorKind =
  | "already-deployed"
  | "insufficient-gas"
  | "nonce-conflict"
  | "rpc-unreachable"
  | "unauthorized"
  | "paused"
  | "unknown";

export type SafeDeployErrorReport = {
  kind: SafeDeployErrorKind;
  message: string;
};

const SAFE_DEPLOY_PREFIX = "Safe deploy failed";

export function formatSafeDeployError(error: unknown): SafeDeployErrorReport {
  const classified = classifyRevert(error);

  if (classified.kind === "string-revert") {
    const reason = classified.reason.toLowerCase();
    if (reason.includes("create2 call failed")) {
      return {
        kind: "already-deployed",
        message:
          'A Safe is already deployed at the deterministic address for this org on this chain, but our database doesn\'t know about it. Click "Sync from chain" in the wallet panel to adopt the existing Safe, then try your action again.',
      };
    }
    if (reason.includes("insufficient funds")) {
      return {
        kind: "insufficient-gas",
        message: `${SAFE_DEPLOY_PREFIX}: the deployer wallet has no native balance to pay gas. Top up and retry.`,
      };
    }
    return {
      kind: "unknown",
      message: `${SAFE_DEPLOY_PREFIX}: ${classified.reason}`,
    };
  }

  if (
    classified.kind === "safe-signature-invalid" ||
    classified.kind === "safe-not-authorized"
  ) {
    return {
      kind: "unauthorized",
      message: `${SAFE_DEPLOY_PREFIX}: ${classified.description} (Safe error ${classified.gsCode}).`,
    };
  }
  if (classified.kind === "safe-insufficient-gas") {
    return {
      kind: "insufficient-gas",
      message: `${SAFE_DEPLOY_PREFIX}: ${classified.description} (Safe error ${classified.gsCode}). Top up the wallet's native balance and retry.`,
    };
  }
  if (classified.kind === "paused") {
    return {
      kind: "paused",
      message: `${SAFE_DEPLOY_PREFIX}: the target contract is paused.`,
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  // Heuristic: many provider-layer errors (timeout, ECONNREFUSED, DNS) don't
  // decode through the revert path. Surface a focused message instead of
  // the giant CALL_EXCEPTION blob when we can recognise the pattern.
  const lower = rawMessage.toLowerCase();
  if (
    lower.includes("nonce too low") ||
    lower.includes("nonce has already been used") ||
    lower.includes("replacement transaction underpriced")
  ) {
    return {
      kind: "nonce-conflict",
      message: `${SAFE_DEPLOY_PREFIX}: nonce conflict (a competing tx took our slot). Retry usually clears it.`,
    };
  }
  if (
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("network error") ||
    lower.includes("could not detect network")
  ) {
    return {
      kind: "rpc-unreachable",
      message: `${SAFE_DEPLOY_PREFIX}: the chain's RPC endpoint is unreachable. Retry shortly.`,
    };
  }

  return {
    kind: "unknown",
    message: `${SAFE_DEPLOY_PREFIX}: ${rawMessage}`,
  };
}
