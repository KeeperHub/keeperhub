/**
 * Pure interface definitions for the scan suggestion engine.
 *
 * IMPORTANT: This file must NOT import "server-only" and must NOT import from
 * lib/scan/types.ts. Phase 53 client components import SuggestionDescriptor
 * directly; a transitive server-only import would crash the client build.
 */

/** Priority-ordered categories for suggestion ranking. */
export type SuggestionCategory = "health" | "yield" | "alert" | "claim";

/**
 * A single actionable suggestion produced by the scan engine for a scanned
 * wallet address.
 *
 * The engine emits at most 7 descriptors, ranked by category (health >
 * yield > alert > claim) and then by USD value descending within each
 * category. Positions below $100 USD are filtered out before ranking.
 */
export interface SuggestionDescriptor {
  /**
   * Deterministic slug: `${category}-${protocol}-${chainId}[-${suffix}]`.
   * Never uses uuid or random values so prefill generation is idempotent.
   */
  id: string;
  name: string;
  /** References actual scanned values (HF, USD amount, protocol, chain). */
  description: string;
  category: SuggestionCategory;
  /**
   * REQUIRED. The chain on which the position was detected.
   * Engine cannot emit a descriptor without a chainId (SUGGEST-08).
   */
  chainId: number;
  readOrWrite: "read" | "write";
  /**
   * User-facing parameter prompts displayed on the Phase 53 confirm screen
   * before the workflow is saved.
   */
  confirmInputs: Record<string, string>;
  /** Per-card risk disclosure shown alongside the suggestion. */
  riskNote: string;
  /** Source protocol identifier — used by the factory to select the workflow shape. */
  protocol?: string;
  /** USD value of the underlying position — used for intra-category ranking. */
  usdValue: number | null;
  /**
   * Token symbol for stablecoin-derived suggestions (yield, balance-drop).
   * Drives the token picker when sibling suggestions are grouped into one
   * card. Absent on position-derived suggestions (health, claim).
   */
  symbol?: string;
  /**
   * Token decimals for stablecoin-derived suggestions. Lets the preview drawer
   * render a base-unit `alertThreshold` as a human-readable amount. Absent when
   * no token-decimal-scaled threshold is present.
   */
  decimals?: number;
  /** Live APY (percent) when the suggestion carries an APY-aware venue. */
  apy?: number;
  /** Human-readable venue label (e.g. "Morpho Blue") for APY-aware yield suggestions. */
  venue?: string;
}

/**
 * Global disclaimer appended to every suggestions response.
 * Satisfies SUGGEST-10.
 */
export const SUGGESTION_DISCLAIMER =
  "This is not financial advice. KeeperHub does not provide financial advice. Automations act on live on-chain data; always verify your positions and thresholds before enabling a workflow.";
