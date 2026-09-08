/**
 * Platform default value caps, applied whenever an organization has not
 * configured a cap of its own.
 *
 * Before these existed, a missing `organization_spend_caps` row -- or a null
 * column for one chain family -- meant unlimited. Only an admin visiting the
 * spend-cap UI ever created a row, so every organization was unlimited by
 * default and a leaked API key was bounded only by the wallet balance. The
 * caps below are the fail-closed floor: an organization must raise its own
 * ceiling deliberately rather than inherit an unbounded one.
 *
 * The two native figures are denominated in the native asset, NOT in USD, so
 * their USD worth drifts with the market: if ETH doubles, the real ceiling
 * doubles with it and nothing alerts. A Chainlink native/USD read does exist in
 * this codebase (`getNativeUsdPrice` in lib/safe/price-oracle.ts, 60s cached,
 * used pre-broadcast by the Safe simulate routes), but the reservation runs
 * inside a `SELECT ... FOR UPDATE` transaction and neither reservation entry
 * point carries a chain id -- `reserveOrgValue` has none at all -- so pricing
 * here would mean holding a row lock across an RPC round trip on a path that
 * has no chain to price. The figures are therefore fixed, chosen at the
 * reference price stated on each, and the drift is accepted deliberately.
 *
 * Each default is overridable from the environment, and both values.yaml files
 * set it explicitly for the app and the executor, so widening one that is
 * binding a live integrator is a values edit and a release rather than a code
 * change. It is not instant: `type: kv` means the new figure ships with a helm
 * upgrade. Anything faster would need the key moved to parameterStore, where a
 * value change plus a pod restart is enough.
 *
 * (`AGENTIC_WALLET_DAILY_CAP_MICROS` makes the same "tune without a deploy"
 * claim and is wired into neither environment, so it is not the precedent it
 * appears to be.)
 */

// The reference ceiling these are chosen against is the 200 USD/day figure
// lib/agentic-wallet/daily-spend.ts already applies to agent-signed spend --
// the one ratified spend-policy number in the codebase. Each default below
// sits at or under it deliberately: a default that binds too tightly is a
// values.yaml edit, while one that binds too loosely is an unbounded outflow
// nobody notices. The rollout
// widens from here on evidence (watch spend_cap_default_applied), rather than
// starting wide and tightening after an incident.

// 0.02 ETH, about 80 USD at a 4,000 USD/ETH reference price.
//
// Denominated in ETH, not USD, so the realized ceiling moves with the market.
// The figure is picked so that drift cannot carry it above the 200 USD anchor
// until ETH passes roughly 10,000 USD -- the upward direction is the dangerous
// one, because nothing alerts when a cap silently widens. Applies to every EVM
// chain, testnets included, because the ledger column it is compared against is
// chain-agnostic.
const DEFAULT_DAILY_VALUE_CAP_WEI = "20000000000000000";

// 0.5 SOL, about 100 USD at a 200 USD/SOL reference price. Same drift
// reasoning: stays under the 200 USD anchor until SOL passes roughly 400 USD.
const DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS = "500000000";

// 100 USD in micro-USD (6 decimals), the unit stablecoins are compared in.
//
// Half the anchor rather than equal to it, because this ceiling is PER
// TRANSACTION and nothing aggregates it: the per-key rate limit is the only
// thing bounding the daily total, which leaves far more headroom than the
// native caps have. What this figure actually sizes is the single worst
// transaction a leaked key can push through, so it is set below the daily
// anchor rather than at it.
//
// Deliberately its own constant rather than a re-export of the agentic wallet's
// DEFAULT_DAILY_CAP_MICROS: that figure is a DAILY AGGREGATE for a different
// subsystem and this one bounds a SINGLE transfer, so they are not the same
// policy even though they were chosen from the same anchor. Coupling them would
// mean an edit to the agentic wallet's daily budget silently moved the
// execution API's per-transfer ceiling.
const DEFAULT_STABLECOIN_CAP_MICRO_USD = "100000000";

// 2,000 USD in micro-USD: the ceiling on ONE transaction's total stablecoin
// outflow, distinct from the per-call figure above.
//
// A Tempo batch payout packs up to MAX_PAYOUTS (50) recipients into a single
// transaction. Measuring that total against the per-call 100 USD would cap a
// 50-recipient payroll at 2 USD a head, which is not a bound on the feature so
// much as its removal. The two figures do different jobs: the per-call ceiling
// stops any one recipient being large, and this one stops the batch as a whole
// being large, so neither a single 990 USD entry nor fifty 100 USD entries get
// through.
//
// 20x the per-call figure. Sized so an ordinary payroll run clears it while a
// batch still cannot move materially more than a handful of single transfers.
const DEFAULT_BATCH_STABLECOIN_CAP_MICRO_USD = "2000000000";

// BigInt() accepts hex-prefixed strings ("0x10" -> 16), so an ops typo would
// silently turn a cap into a near-zero one. Reject anything that is not a
// decimal digit run before it is used.
const DECIMAL_INTEGER_RE = /^\d+$/;

function resolveOverride(
  envValue: string | undefined,
  fallback: string
): string {
  if (!(envValue && DECIMAL_INTEGER_RE.test(envValue))) {
    return fallback;
  }
  return BigInt(envValue) > BigInt(0) ? envValue : fallback;
}

/** Default daily EVM native value cap, in wei. */
export function getDefaultDailyValueCapWei(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_DAILY_VALUE_CAP_WEI,
    DEFAULT_DAILY_VALUE_CAP_WEI
  );
}

/** Default daily Solana native value cap, in lamports. */
export function getDefaultDailySolanaValueCapLamports(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS,
    DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS
  );
}

/**
 * Ceiling on a single stablecoin outflow, in micro-USD (6 decimals).
 *
 * Per transfer, not per day. A daily total would need a third unit column on
 * the value ledger (micro-USD alongside wei and lamports) and a reserve/settle
 * lifecycle for token moves; this bounds each individual move instead, which is
 * what the 1:1 peg and the recorded token decimals support with no oracle. The
 * residual is that the per-key rate limit, not this cap, bounds the aggregate.
 */
export function getDefaultStablecoinTransferCapMicroUsd(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_STABLECOIN_CAP_MICRO_USD,
    DEFAULT_STABLECOIN_CAP_MICRO_USD
  );
}

/**
 * Ceiling on the total stablecoin outflow of a single transaction, in
 * micro-USD (6 decimals).
 *
 * Applies alongside the per-call figure rather than instead of it: every call
 * in a batch is still individually bounded, and this bounds their sum.
 */
export function getDefaultBatchStablecoinCapMicroUsd(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_BATCH_STABLECOIN_CAP_MICRO_USD,
    DEFAULT_BATCH_STABLECOIN_CAP_MICRO_USD
  );
}
