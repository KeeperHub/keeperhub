/** Base mainnet chain id -- the only network PAYG settles on today. */
export const PAYG_DEFAULT_CHAIN_ID = 8453;

/**
 * Spend caps every free-tier org starts with. Pay-as-you-go covers all of them,
 * so these bound the spend of an org that has never opened Billing to set its
 * own. Decimal USDC; the server converts to raw units.
 */
export const PAYG_DEFAULT_DAILY_CAP_USDC = "5";
export const PAYG_DEFAULT_PERIOD_CAP_USDC = "50";

/** `payg_payments.status` values. */
export const PAYG_PAYMENT_STATUS = {
  settled: "settled",
  pending: "pending",
} as const;
export type PaygPaymentStatus =
  (typeof PAYG_PAYMENT_STATUS)[keyof typeof PAYG_PAYMENT_STATUS];

/**
 * Executor billing-guard reason signalling a free-tier org that is past its
 * included limit with PAYG enabled -- the caller settles the per-execution
 * charge before running. Shared between the guard and its consumer so the
 * string contract cannot drift.
 */
export const PAYG_OVERFLOW_REASON = "payg_overflow";

/**
 * x402 `exact` EVM settlement constants (EIP-3009 USDC). The EIP-712 domain
 * name/version identify USDC to the facilitator; the scheme and network id are
 * part of the PaymentRequirements contract.
 */
export const X402_EXACT_SCHEME = "exact";
export const USDC_EIP712_NAME = "USD Coin";
export const USDC_EIP712_VERSION = "2";
export const PAYG_RESOURCE_URL = "https://keeperhub.com/payg";

/** CAIP-2 network id for an EVM chain (e.g. `eip155:8453`). */
export function evmNetworkId(chainId: number): string {
  return `eip155:${chainId}`;
}
