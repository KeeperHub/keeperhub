import "server-only";
import type { Address } from "viem";

function getPimlicoBaseUrl(): string {
  const url = process.env.PIMLICO_BASE_URL;
  if (!url) {
    throw new Error("PIMLICO_BASE_URL not configured");
  }
  return url;
}

/**
 * Chain IDs where gas sponsorship via EIP-7702 + Pimlico is supported.
 * Chains must support both EIP-7702 and have Pimlico bundler coverage.
 */
export const SUPPORTED_SPONSORSHIP_CHAINS: ReadonlySet<number> = new Set([
  8453, // Base
  84_532, // Base Sepolia
  10, // Optimism
  42_161, // Arbitrum One
  137, // Polygon
  1, // Ethereum Mainnet
  11_155_111, // Sepolia
]);

export function isSponsorshipSupported(chainId: number): boolean {
  return SUPPORTED_SPONSORSHIP_CHAINS.has(chainId);
}

/**
 * SimpleAccount7702 implementation address for EIP-7702 delegation.
 * Must match the default `accountLogicAddress` in permissionless.js's
 * `toSimpleSmartAccount` -- deployed by Pimlico on all supported chains.
 */
export function getSimpleAccount7702Address(): Address {
  const address = process.env.SIMPLE_ACCOUNT_7702_ADDRESS;
  if (!address) {
    throw new Error("SIMPLE_ACCOUNT_7702_ADDRESS not configured");
  }
  return address as Address;
}

export function getPimlicoUrl(chainId: number): string {
  const apiKey = process.env.PIMLICO_API_KEY;
  if (!apiKey) {
    throw new Error("PIMLICO_API_KEY not configured");
  }
  return `${getPimlicoBaseUrl()}/${chainId}/rpc?apikey=${apiKey}`;
}
