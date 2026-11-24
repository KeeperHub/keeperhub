/**
 * Gas Defaults & Override Parsing (Client-Safe)
 *
 * Two related concerns live here:
 *
 *  1. CHAIN_GAS_DEFAULTS / getChainGasDefaults(chainId)
 *     Display-only gas limit multipliers. Each entry must carry the same
 *     gasLimitMultiplier as the matching chain in getHardcodedOverrides in
 *     gas-strategy.ts (kept in sync by hand: that module imports ethers and
 *     the DB, so it cannot be imported here). /api/gas/estimate returns these
 *     next to the estimate so clients can show what default would apply.
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

// Exported so the parity test can iterate every chain listed here rather than
// a hand-kept copy of the ids, which would reintroduce the hand-sync it guards.
export const CHAIN_GAS_DEFAULTS: Readonly<Record<number, ChainGasDefaults>> = {
  // Ethereum mainnet
  1: { multiplier: 2.0 },
  // Sepolia testnet
  11155111: { multiplier: 2.0 },
  // Arbitrum One
  42161: { multiplier: 1.5 },
  // Arbitrum Sepolia
  421614: { multiplier: 1.5 },
  // Base
  8453: { multiplier: 1.5 },
  // Base Sepolia
  84532: { multiplier: 1.5 },
  // Polygon
  137: { multiplier: 2.0 },
  // Polygon Amoy testnet
  80002: { multiplier: 2.0 },
  // Robinhood Chain
  4663: { multiplier: 1.5 },
  // Robinhood Chain testnet
  46630: { multiplier: 1.5 },
  // HyperEVM (3,000,000 block gas limit). 1.5x keeps a typical estimate
  // inside the limit where 2x would not; it is not a cap. An estimate above
  // ~2,000,000 still multiplies past the limit, and blocks routinely reach
  // 0.7 to 0.9 of it: across 80 consecutive blocks sampled on 2026-09-22 the
  // median was 0.50, 26 blocks sat at 0.7 or above and the fullest used
  // 2,977,796 gas. So the headroom is real but finite. Clamping to the block
  // gas limit would be the structural fix and no chain entry does that
  // today, so it is left out of a chain add.
  999: { multiplier: 1.5 },
  // 0G Galileo testnet
  16602: { multiplier: 2.0 },
  // 0G Mainnet
  16661: { multiplier: 2.0 },
  // Tempo mainnet
  4217: { multiplier: 1.5 },
  // Tempo Moderato testnet
  42431: { multiplier: 1.5 },
};

const GLOBAL_DEFAULT: ChainGasDefaults = {
  multiplier: 2.0,
};

/**
 * Get gas limit multiplier defaults for a chain.
 * Returns global defaults if the chain has no specific overrides.
 */
export function getChainGasDefaults(chainId: number): ChainGasDefaults {
  return CHAIN_GAS_DEFAULTS[chainId] ?? GLOBAL_DEFAULT;
}

/** The fixed Gas Limit to use as is, or undefined when the gas is estimated. */
export function fixedGasLimit(
  gasLimitOverride: bigint | undefined
): bigint | undefined {
  return gasLimitOverride !== undefined && gasLimitOverride > BigInt(0)
    ? gasLimitOverride
    : undefined;
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

export const MAX_PRIORITY_FEE_GWEI = 10_000;
export const MAX_FEE_GWEI = 10_000;

const GWEI_DECIMAL_RE = /^(\d+)(?:\.(\d{1,9}))?$/;
const WEI_PER_GWEI = BigInt(1_000_000_000);

type GweiParse =
  | { ok: true; wei: bigint | undefined }
  | { ok: false; error: string };

/**
 * Parse a caller-supplied gwei amount exactly, as a plain decimal with at
 * most 9 fractional digits (1 wei). Unset or blank means "not set". The same
 * parse feeds validation and the wei value, so a value that validates is the
 * value that is sent. Client-safe: no ethers.
 */
function parseGweiSetting(label: string, raw: unknown, max: number): GweiParse {
  if (raw === undefined || raw === null) {
    return { ok: true, wei: undefined };
  }
  const text =
    typeof raw === "string" || typeof raw === "number"
      ? String(raw).trim()
      : "";
  if (text === "" && typeof raw === "string") {
    return { ok: true, wei: undefined };
  }
  const match = GWEI_DECIMAL_RE.exec(text);
  if (!match) {
    return {
      ok: false,
      error: `${label} must be a positive decimal number in gwei with at most 9 decimal places, got "${String(raw)}"`,
    };
  }
  const fraction = (match[2] ?? "").padEnd(9, "0");
  const wei = BigInt(match[1]) * WEI_PER_GWEI + BigInt(fraction);
  if (wei === BigInt(0)) {
    return { ok: false, error: `${label} must be greater than 0 gwei` };
  }
  if (wei > BigInt(max) * WEI_PER_GWEI) {
    return { ok: false, error: `${label} must not exceed ${max} gwei` };
  }
  return { ok: true, wei };
}

/**
 * Validate a caller-supplied priority fee (gwei). Returns an error message for
 * a value that is set but unusable, so a typo fails the step instead of
 * silently sending at the default tip. Empty means "use the default".
 */
export function priorityFeeGweiError(raw: unknown): string | undefined {
  const parsed = parseGweiSetting("Priority fee", raw, MAX_PRIORITY_FEE_GWEI);
  return parsed.ok ? undefined : parsed.error;
}

export type FeeOverrides =
  | { error: string }
  | { priorityFeeOverride?: bigint; maxFeeOverride?: bigint };

/**
 * Resolve a write node's priority fee and max fee settings to wei. A max fee
 * below the priority fee would silently lower the tip, so it is refused.
 */
export function resolveFeeOverrides(
  priorityFeeRaw: unknown,
  maxFeeRaw: unknown
): FeeOverrides {
  const priority = parseGweiSetting(
    "Priority fee",
    priorityFeeRaw,
    MAX_PRIORITY_FEE_GWEI
  );
  if (!priority.ok) {
    return { error: priority.error };
  }
  const max = parseGweiSetting("Max fee", maxFeeRaw, MAX_FEE_GWEI);
  if (!max.ok) {
    return { error: max.error };
  }
  if (
    priority.wei !== undefined &&
    max.wei !== undefined &&
    max.wei < priority.wei
  ) {
    return { error: "Max fee must be at least the priority fee" };
  }
  return { priorityFeeOverride: priority.wei, maxFeeOverride: max.wei };
}
