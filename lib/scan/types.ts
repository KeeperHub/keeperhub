import "server-only";

import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

/**
 * Scan schema version. Downstream consumers (suggestion engine, UI) guard on
 * this value to detect breaking shape changes.
 */
export const SCAN_SCHEMA_VERSION = 1;

/**
 * A single supplied or borrowed token in a lending position.
 *
 * `amount` is a stringified bigint in base units (e.g. wei for ETH) so no
 * precision is lost during JSON serialisation. `usdValue` is a derived
 * display number only — use `amount` + `decimals` for exact math.
 */
export interface PositionAsset {
  symbol: string;
  tokenAddress: string;
  /** Raw token balance in base units, stringified to preserve bigint precision. */
  amount: string;
  decimals: number;
  /** USD value derived for display. null when the price is unavailable. */
  usdValue: number | null;
}

/**
 * A detected lending/borrowing position on a supported protocol.
 *
 * `healthFactor` is null when there is no active debt (Aave V3 returns
 * MaxUint256 in that case; the adapter normalises it to null). When null,
 * `noActiveLoan` is always true.
 */
export interface ProtocolPosition {
  chainId: number;
  protocol: "aave-v3" | "lido" | "spark" | "sky";
  /** null when there is no active loan (supply-only user). */
  healthFactor: number | null;
  /** true when the user has no borrowed assets on this protocol+chain. */
  noActiveLoan?: boolean;
  totalCollateralUsd: number | null;
  totalDebtUsd: number | null;
  /** Aave V3 efficiency mode category; 0 means no eMode. */
  emodeCategory?: number;
  suppliedAssets: PositionAsset[];
  borrowedAssets: PositionAsset[];
}

/**
 * A stablecoin balance detected for the scanned address.
 *
 * `depegged` is true when the Chainlink price deviates more than 0.5% from
 * $1.00 (price < $0.995 or > $1.005).
 */
export interface StablecoinBalance {
  chainId: number;
  symbol: string;
  tokenAddress: string;
  /** Raw balance in base units, stringified. */
  amount: string;
  decimals: number;
  /** USD value derived for display. null when the price is unavailable. */
  usdValue: number | null;
  /** Chainlink price in USD. null when no feed is available for this chain. */
  priceUsd: number | null;
  /** true when the Chainlink price deviates >= 0.5% from $1.00. */
  depegged: boolean;
}

/**
 * Marker for a chain that could not be scanned (timeout, RPC failure, etc.).
 * The scan still returns HTTP 200; partial results are a first-class state.
 */
export interface UnavailableChain {
  chainId: number;
  /** Human-readable reason, RPC URLs and API keys scrubbed. */
  reason: string;
}

/**
 * Top-level response from the scan endpoint.
 *
 * All money amounts are stringified bigints; `usdValue` fields are derived
 * display numbers only. `unavailableChains` is non-empty when one or more
 * chains timed out or returned an RPC error.
 */
export interface ScanResponse {
  schemaVersion: number;
  /** EIP-55 checksummed address. */
  address: string;
  /**
   * The ENS name the caller entered, when the request was an ENS lookup that
   * resolved to `address`. Absent for raw-address scans. Lets the UI show the
   * name → address mapping the user typed.
   */
  ensName?: string;
  positions: ProtocolPosition[];
  stablecoins: StablecoinBalance[];
  unavailableChains: UnavailableChain[];
  /** ISO 8601 timestamp of when the scan was executed (or served from cache). */
  scannedAt: string;
  /**
   * "contract" when deployed bytecode exists on at least one scanned chain,
   * "eoa" otherwise. Optional for backward compatibility: absent on cached
   * rows that pre-date detection or when every getCode probe failed.
   */
  addressKind?: "eoa" | "contract";
  /** Chains where bytecode was found. Present only when addressKind is "contract". */
  contractChains?: number[];
  /**
   * Ranked, capped suggestion descriptors derived from the scan output.
   * Optional for backward compatibility — Phase 51 callers and cached rows
   * that pre-date this field still validate. Absent when buildSuggestions
   * throws or the scan has no qualifying positions.
   */
  suggestions?: SuggestionDescriptor[];
}

/**
 * Output produced by scanning a single chain — used as the element type
 * in the `chainOutputs` array returned by `scanChains`.
 */
export interface ChainScanOutput {
  chainId: number;
  positions: ProtocolPosition[];
  stablecoins: StablecoinBalance[];
}

/**
 * A single call descriptor passed to the Multicall3 aggregate3 batch.
 * Mirrors the on-chain struct exactly so no mapping is needed.
 */
export interface AdapterCallDescriptor {
  target: string;
  allowFailure: boolean;
  callData: string;
}

/**
 * Result of a single Multicall3 aggregate3 sub-call.
 */
export interface MulticallResult {
  success: boolean;
  returnData: string;
}

/**
 * Contract that every protocol adapter must implement.
 *
 * Adapters are pure-function modules: `buildCalls` encodes the RPC reads
 * for one address on one chain; `decode` interprets the raw aggregate3
 * results and returns zero or more positions. The scanner orchestrator
 * batches calls from all adapters into a single `aggregate3.staticCall`.
 */
export interface ProtocolAdapter {
  /** Stable identifier used in `ProtocolPosition.protocol`. */
  readonly protocol: "aave-v3" | "lido" | "spark" | "sky";

  /**
   * Return the ordered list of Multicall3 call descriptors for this adapter.
   * The orchestrator concatenates calls from all adapters before submitting
   * a single batch.
   */
  buildCalls(address: string, chainId: number): AdapterCallDescriptor[];

  /**
   * Decode the raw aggregate3 results that correspond to this adapter's calls.
   * `results` is a slice of the full batch output, aligned to the calls
   * returned by `buildCalls`. Returns an empty array when the position is
   * absent or all sub-calls failed.
   */
  decode(
    results: MulticallResult[],
    address: string,
    chainId: number
  ): ProtocolPosition[];
}
