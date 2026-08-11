/**
 * Gas Defaults & Override Parsing (Client-Safe)
 *
 * Two related concerns live here:
 *
 *  1. CHAIN_GAS_DEFAULTS / getChainGasDefaults(chainId)
 *     Display-only multipliers mirroring the hardcoded entries in
 *     gas-strategy.ts. UI code (e.g. gas-limit-multiplier-field.tsx) reads
 *     these to show users what default would apply.
 *
 *  2. resolveGasLimitOverrides / parsePriorityFeeGwei
 *     Execution-path helpers that turn user-supplied strings into the
 *     bigint/number overrides the gas strategy accepts. Shared between
 *     write-contract / transfer-funds / transfer-token step handlers.
 *
 * Execution still uses DB -> hardcoded -> default resolution in
 * gas-strategy.ts; this file does NOT replace that lookup. It only parses
 * caller inputs and exposes display defaults.
 *
 * Must remain ethers-free so it stays bundle-safe for the React canvas.
 */

export type ChainGasDefaults = {
  multiplier: number;
  conservative: number;
};

/**
 * Gas limit configuration - supports both multiplier and absolute gas limit modes
 */
export type GasLimitConfig =
  | { mode: "multiplier"; value: string }
  | { mode: "maxGasLimit"; value: string };

/**
 * Parse gas limit config from the stored string value.
 *
 * Supports:
 * - New JSON format: '{"mode":"multiplier","value":"2.5"}' or '{"mode":"maxGasLimit","value":"500000"}'
 * - Legacy plain string: "2.5" → treated as { mode: "multiplier", value: "2.5" }
 * - Empty/undefined: returns undefined
 */
export function parseGasLimitConfig(
  raw: string | undefined
): GasLimitConfig | undefined {
  if (!raw || raw.trim() === "") {
    return;
  }

  // Try parsing as JSON first (new format)
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        mode?: string;
        value?: string;
      };
      if (parsed.mode === "multiplier" || parsed.mode === "maxGasLimit") {
        return { mode: parsed.mode, value: parsed.value ?? "" };
      }
    } catch {
      // Fall through to legacy handling
    }
  }

  // Legacy format: plain numeric string → multiplier mode
  return { mode: "multiplier", value: raw };
}

const CHAIN_GAS_DEFAULTS: Record<number, ChainGasDefaults> = {
  // Ethereum mainnet
  1: { multiplier: 2.0, conservative: 2.5 },
  // Sepolia testnet
  11155111: { multiplier: 2.0, conservative: 2.5 },
  // Arbitrum One
  42161: { multiplier: 1.5, conservative: 2.0 },
  // Arbitrum Sepolia
  421614: { multiplier: 1.5, conservative: 2.0 },
  // Base
  8453: { multiplier: 1.5, conservative: 2.0 },
  // Base Sepolia
  84532: { multiplier: 1.5, conservative: 2.0 },
  // Polygon
  137: { multiplier: 2.0, conservative: 2.5 },
  // Polygon Amoy testnet
  80002: { multiplier: 2.0, conservative: 2.5 },
  // 0G Galileo testnet
  16602: { multiplier: 2.0, conservative: 2.5 },
  // 0G Mainnet
  16661: { multiplier: 2.0, conservative: 2.5 },
};

const GLOBAL_DEFAULT: ChainGasDefaults = {
  multiplier: 2.0,
  conservative: 2.5,
};

/**
 * Get gas limit multiplier defaults for a chain.
 * Returns global defaults if the chain has no specific overrides.
 */
export function getChainGasDefaults(chainId: number): ChainGasDefaults {
  return CHAIN_GAS_DEFAULTS[chainId] ?? GLOBAL_DEFAULT;
}

export type GasLimitOverrides = {
  multiplierOverride?: number;
  gasLimitOverride?: bigint;
  priorityFeeOverride?: bigint;
};

/**
 * Resolve gas limit config into overrides for the gas strategy.
 * Shared by all step handlers (write-contract, transfer-funds, transfer-token).
 */
export function resolveGasLimitOverrides(
  raw: string | undefined
): GasLimitOverrides {
  const config = parseGasLimitConfig(raw);
  if (!config) {
    return {};
  }

  if (config.mode === "maxGasLimit") {
    const value = Number.parseFloat(config.value);
    if (!Number.isNaN(value) && value > 0) {
      return { gasLimitOverride: BigInt(Math.floor(value)) };
    }
  } else if (config.mode === "multiplier") {
    const value = Number.parseFloat(config.value);
    if (!Number.isNaN(value)) {
      return { multiplierOverride: Math.max(1.0, Math.min(10.0, value)) };
    }
  }

  return {};
}

/**
 * Convert a caller-supplied priority fee (gwei, decimal string) to wei.
 * Returns undefined when the value is missing, malformed, or non-positive --
 * callers should fall through to the default chain-clamped strategy in that
 * case rather than raising. Implemented without ethers so this module remains
 * client-safe (gas-limit-multiplier-field.tsx imports it). Float64 has
 * ~15-16 decimal digits of precision, which comfortably covers gwei values
 * up to ~10^7 (well past any realistic priority fee).
 */
export function parsePriorityFeeGwei(
  raw: string | undefined
): bigint | undefined {
  if (!raw || raw.trim() === "") {
    return;
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  return BigInt(Math.floor(value * 1e9));
}
