/**
 * Risk classifier for agentic-wallet signing requests.
 *
 * Three-tier risk model anchored to 33-RESEARCH.md Pattern 6 (lines 542-566):
 *   - "block": amount > 100 USDC (> 100_000_000 micro-USDC) OR selector is
 *              the ERC-20 unlimited-approve selector `0x095ea7b3`. These are
 *              operations Turnkey policy would deny anyway; we pre-empt so
 *              `/sign` never reaches Turnkey.
 *   - "ask":   amount >= 50 USDC (>= 50_000_000 micro-USDC) OR a non-empty
 *              selector that is not in KNOWN_SAFE_SELECTORS. These require a
 *              human decision via `/approval-request`.
 *   - "auto":  everything else -- paid workflow calls under $50, plain
 *              transfers of small amounts, etc.
 *
 * Pure function, no I/O. `challenge.amount` is a string decimal integer in
 * micro-USDC (6 decimals). Comparison uses BigInt directly so that amounts
 * larger than Number.MAX_SAFE_INTEGER are still classifiable and that
 * sub-cent precision (e.g. 100.000001 USDC) is preserved for the block tier.
 */

export type RiskLevel = "auto" | "ask" | "block";

export type RiskPayload = {
  chain: "base" | "tempo";
  challenge: {
    amount: string;
    payTo: string;
    selector?: string;
  };
};

/**
 * Selectors that are known-safe targets. Extended in Phase 34.
 *   - 0xa9059cbb: ERC-20 `transfer(address,uint256)` (capped to 100 USDC by
 *                Turnkey baseline policy)
 *   - 0x23b872dd: ERC-20 `transferFrom(address,address,uint256)` (same cap)
 *
 * x402 EIP-3009 signing does NOT carry a selector -- it is typed-data, not
 * calldata. For x402 `selector` is undefined and amount-tier rules apply.
 */
export const KNOWN_SAFE_SELECTORS: ReadonlySet<string> = new Set([
  "0xa9059cbb",
  "0x23b872dd",
]);

// 0x095ea7b3: ERC-20 `approve(address,uint256)`. Unlimited-approve is already
// policy-blocked (>= 2^32), so we pre-empt ALL approves here -- the Phase 34
// hook layer can widen this if a safe approve path is needed.
const APPROVE_SELECTOR = "0x095ea7b3";

// Thresholds in cents, then expressed in micro-USDC for sub-cent precision.
// 1 USDC = 1_000_000 micro = 100 cents, so micro = cents * 10_000.
const ASK_THRESHOLD_CENTS = 50 * 100; // $50
const BLOCK_THRESHOLD_CENTS = 100 * 100; // $100

const MICRO_PER_CENT = BigInt(10_000);
const ASK_THRESHOLD_MICRO = BigInt(ASK_THRESHOLD_CENTS) * MICRO_PER_CENT; // 50_000_000
const BLOCK_THRESHOLD_MICRO = BigInt(BLOCK_THRESHOLD_CENTS) * MICRO_PER_CENT; // 100_000_000

/**
 * Parse a micro-USDC (6-decimal) decimal-integer string into a bigint count
 * of micro-USDC. Returns 0 on malformed input so unknown shapes fall through
 * to the selector-based tier rules.
 */
function parseAmountMicro(amountStr: string): bigint {
  try {
    return BigInt(amountStr);
  } catch {
    return BigInt(0);
  }
}

export function classifyRisk(payload: RiskPayload): RiskLevel {
  const micro = parseAmountMicro(payload.challenge.amount);
  const { selector } = payload.challenge;

  // Hard-block rules first. Unlimited-approve is always denied; it exists
  // only so the `/sign` path never talks to Turnkey for a doomed request.
  if (selector === APPROVE_SELECTOR) {
    return "block";
  }
  if (micro > BLOCK_THRESHOLD_MICRO) {
    return "block";
  }

  // Ask rules.
  if (micro >= ASK_THRESHOLD_MICRO) {
    return "ask";
  }
  if (selector && !KNOWN_SAFE_SELECTORS.has(selector)) {
    return "ask";
  }

  return "auto";
}
