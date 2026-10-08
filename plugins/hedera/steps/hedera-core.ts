import "server-only";

/**
 * Shared helpers for the hedera plugin.
 *
 * This module is intentionally dependency-free: everything here is pure
 * validation and URL building so the read path (verify-message) never pulls
 * the @hashgraph/sdk into the server bundle.
 */

export type HederaNetwork = "testnet" | "mainnet";

export const HEDERA_MIRROR_API: Record<HederaNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
};

const ENTITY_ID_RE = /^0\.0\.\d{1,19}$/;

// Topics and accounts share the 0.0.<number> entity-id shape.
export function isValidEntityId(value: string): boolean {
  return ENTITY_ID_RE.test(value.trim());
}

export function resolveNetwork(raw: string | undefined): HederaNetwork | null {
  const v = (raw || "testnet").toLowerCase();
  return v === "mainnet" || v === "testnet" ? (v as HederaNetwork) : null;
}
