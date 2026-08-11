import "server-only";

import { ethers } from "ethers";
import { ErrorCategory, logSystemError } from "@/lib/logging";

const TREASURY_ENV_PREFIX = "PAYG_TREASURY_ADDRESS_";

/**
 * Platform treasury address that PAYG payments settle into, resolved per chain
 * from env (Parameter Store). Never hardcoded and never sourced from execution
 * input. Returns null when unset or malformed so the org is treated as not
 * configured rather than paying to a bad address.
 */
export function getPaygTreasuryOrNull(chainId: number): string | null {
  const raw = process.env[`${TREASURY_ENV_PREFIX}${chainId}`];
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!ethers.isAddress(trimmed)) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      `[PAYG] Invalid treasury address configured for chain ${chainId}`,
      new Error("invalid treasury address"),
      { operation: "getPaygTreasury" }
    );
    return null;
  }
  return ethers.getAddress(trimmed);
}

export function getPaygTreasury(chainId: number): string {
  const address = getPaygTreasuryOrNull(chainId);
  if (!address) {
    throw new Error(
      `[PAYG] No treasury configured for chain ${chainId}; set ${TREASURY_ENV_PREFIX}${chainId}`
    );
  }
  return address;
}
