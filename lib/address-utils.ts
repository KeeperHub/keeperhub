/**
 * EVM address utilities for KeeperHub.
 *
 * Convention: store lowercase (consistent, easy to compare/index), display
 * checksummed (EIP-55; user safety, professional appearance), accept both on
 * input (normalize with getAddress from ethers).
 */

import { ethers } from "ethers";

// Solana base58 addresses are 32-44 chars. Client-safe (no @solana/web3.js
// import) - excludes 0/O/I/l so it never collides with 0x-prefixed EVM hex.
// Format check only; full validation (32-byte decode) happens server-side
// via lib/web3/validate-chain-address.ts.
const SOLANA_BASE58_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * True when the value is shaped like a Solana base58 address. Does not
 * decode or validate the key - see the pattern comment above.
 */
export function isSolanaAddressFormat(address: string): boolean {
  return SOLANA_BASE58_ADDRESS_PATTERN.test(address);
}

/**
 * Returns the EIP-55 checksummed form of an EVM address.
 * If the address is invalid or corrupt, returns it unchanged so UI never crashes.
 */
export function toChecksumAddress(address: string): string {
  try {
    return ethers.getAddress(address);
  } catch {
    return address;
  }
}

/**
 * Normalizes an EVM address for storage: validates and returns lowercase.
 * Call only after validation (e.g. ethers.isAddress(address)).
 */
export function normalizeAddressForStorage(address: string): string {
  return ethers.getAddress(address).toLowerCase();
}

/**
 * Truncates an Ethereum address for display purposes.
 * Uses EIP-55 checksummed form before slicing so truncated display is always checksummed.
 * If the address is shorter than or equal to the maxLength, returns it unchanged (checksummed).
 * Otherwise, returns a truncated version showing the first 6 characters and last 4 characters.
 *
 * @param address - The Ethereum address to truncate
 * @param maxLength - Maximum length before truncation (default: 10)
 * @returns The truncated address in the format "0x1234...5678" or the original address if it's short enough
 */
export function truncateAddress(address: string, maxLength = 10): string {
  const checksummed = toChecksumAddress(address);
  if (checksummed.length <= maxLength) {
    return checksummed;
  }
  return `${checksummed.slice(0, 6)}...${checksummed.slice(-4)}`;
}
