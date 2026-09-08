/**
 * Shared token-config parsing for the token balance steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 */
import "server-only";

import { and, eq } from "drizzle-orm";
import { isSolanaAddressFormat } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { supportedTokens } from "@/lib/db/schema";
import type { CustomToken, TokenFieldValue } from "@/lib/wallet/types";

// Named TokenBalanceInfo rather than TokenBalance to avoid colliding with
// the structurally different wallet-UI TokenBalance in lib/wallet/types.ts.
export type TokenBalanceInfo = {
  balance: string;
  balanceRaw: string;
  symbol: string;
  decimals: number;
  name: string;
  tokenAddress: string;
};

export type TokenConfigSource = {
  // Optional: legacy stored node configs can omit it entirely.
  tokenConfig?: string | Record<string, unknown>;
  // Legacy support
  tokenAddress?: string;
};

/**
 * Extract mode from parsed config, defaulting to "supported"
 */
function extractMode(parsed: unknown): "supported" | "custom" {
  if (typeof parsed !== "object" || parsed === null) {
    return "supported";
  }

  const config = parsed as Record<string, unknown>;
  return config.mode === "supported" || config.mode === "custom"
    ? (config.mode as "supported" | "custom")
    : "supported";
}

/**
 * Extract supported token ID from parsed config
 * Handles both new (single) and legacy (array) formats
 */
function extractSupportedTokenId(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const config = parsed as Record<string, unknown>;

  // New format: single token ID
  if (typeof config.supportedTokenId === "string") {
    return config.supportedTokenId;
  }

  // Legacy format: array - use first element
  if (
    Array.isArray(config.supportedTokenIds) &&
    config.supportedTokenIds.length > 0
  ) {
    const firstId = config.supportedTokenIds[0];
    return typeof firstId === "string" ? firstId : undefined;
  }

  return;
}

/**
 * Extract custom token from parsed config
 * Handles both new (single) and legacy (array/string) formats
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles multiple legacy formats for backwards compatibility
function extractCustomToken(parsed: unknown): CustomToken | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const config = parsed as Record<string, unknown>;

  // New format: single custom token object
  if (
    config.customToken &&
    typeof config.customToken === "object" &&
    config.customToken !== null
  ) {
    const token = config.customToken as Record<string, unknown>;
    if (typeof token.address === "string" && typeof token.symbol === "string") {
      return { address: token.address, symbol: token.symbol };
    }
  }

  // Legacy format: array of custom tokens - use first element
  if (Array.isArray(config.customTokens) && config.customTokens.length > 0) {
    const firstToken = config.customTokens[0];
    if (
      firstToken &&
      typeof firstToken === "object" &&
      typeof firstToken.address === "string" &&
      typeof firstToken.symbol === "string"
    ) {
      return {
        address: firstToken.address,
        symbol: firstToken.symbol,
      };
    }
  }

  // Legacy format: array of addresses - convert first address to token
  if (
    Array.isArray(config.customTokenAddresses) &&
    config.customTokenAddresses.length > 0
  ) {
    const address = config.customTokenAddresses.find(
      (a): a is string => typeof a === "string" && a.trim() !== ""
    );
    if (address) {
      return { address, symbol: "???" };
    }
  }

  // Legacy format: single address string
  if (typeof config.customTokenAddress === "string") {
    return { address: config.customTokenAddress, symbol: "???" };
  }

  return;
}

/**
 * Parse token config from input
 * Supports both new (single token) and legacy (array) formats
 */
export function parseTokenConfig(input: TokenConfigSource): TokenFieldValue {
  // Legacy support: if tokenAddress is provided directly, use custom mode
  if (input.tokenAddress && !input.tokenConfig) {
    return {
      mode: "custom",
      customToken: { address: input.tokenAddress, symbol: "???" },
    };
  }

  if (!input.tokenConfig) {
    return {
      mode: "supported",
    };
  }

  // Object values from API/MCP-created workflows
  if (typeof input.tokenConfig === "object") {
    return {
      mode: extractMode(input.tokenConfig),
      supportedTokenId: extractSupportedTokenId(input.tokenConfig),
      customToken: extractCustomToken(input.tokenConfig),
    };
  }

  try {
    const parsed = JSON.parse(input.tokenConfig);

    return {
      mode: extractMode(parsed),
      supportedTokenId: extractSupportedTokenId(parsed),
      customToken: extractCustomToken(parsed),
    };
  } catch {
    // If parsing fails and it looks like an address (EVM 0x-hex or Solana
    // base58), treat as custom.
    if (
      input.tokenConfig.startsWith("0x") ||
      isSolanaAddressFormat(input.tokenConfig)
    ) {
      return {
        mode: "custom",
        customToken: { address: input.tokenConfig, symbol: "???" },
      };
    }
    return {
      mode: "supported",
    };
  }
}

/**
 * Get token address to check based on config
 * Returns a single token address (either supported or custom)
 */
export async function getTokenAddress(
  config: TokenFieldValue,
  chainId: number
): Promise<string | null> {
  // Get supported token address from database
  if (config.supportedTokenId) {
    const tokens = await db
      .select({ tokenAddress: supportedTokens.tokenAddress })
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, chainId),
          eq(supportedTokens.id, config.supportedTokenId)
        )
      )
      .limit(1);
    if (tokens[0]?.tokenAddress) {
      return tokens[0].tokenAddress;
    }
  }

  // Get custom token address
  if (config.customToken?.address) {
    return config.customToken.address;
  }

  return null;
}
