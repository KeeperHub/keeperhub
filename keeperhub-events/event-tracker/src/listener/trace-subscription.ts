/**
 * Trace subscription configuration for the trace trigger (issue #2464).
 *
 * A trace subscription matches raw call frames by surface properties
 * (caller, callee, selector, value, revert status) without needing an ABI.
 * This is exactly what eth_getLogs cannot see: reverted drain attempts,
 * internal ETH transfers, delegatecalls into unlogged implementations,
 * and unlogged privileged calls.
 */

export interface TraceSubscription {
  /**
   * Watched contract address (callee). Required - a trace trigger is never
   * chain-wide, unlike event triggers which can watch all contracts.
   */
  contractAddress: string;

  /**
   * Optional caller filter (case-insensitive).
   */
  caller?: string;

  /**
   * 4-byte function selector, e.g. "0x8456cb59" for pause().
   * Only calldata-bearing frame types can match.
   */
  selector?: string;

  /**
   * Specific opcode call types to match, e.g. ["DELEGATECALL"].
   * Empty array or undefined means wildcard (matches all types).
   */
  callTypes?: string[];

  /**
   * Minimum wei value moved by the frame (decimal string).
   *
   * Scoped to frames where the watched contract is the callee, because
   * `frameMatchesSubscriber` requires `frame.to === contractAddress` before
   * any other filter runs. A CREATE carrying an endowment names the new
   * contract in `to`, a SELFDESTRUCT names the beneficiary, so neither
   * matches a subscription on the contract that performed it.
   * Making the address test direction-aware would change matching for every
   * filter, not just this one, so it is left for its own change.
   */
  minValueWei?: string;

  /**
   * Which revert states to include:
   *   "success" - only frames that did not revert (default)
   *   "reverted" - only reverted frames
   *   "any" - both
   */
  status?: "success" | "reverted" | "any";
}
