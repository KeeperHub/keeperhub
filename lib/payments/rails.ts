/**
 * Payment rail identity: the single source of truth for the network, chain id,
 * settlement asset and EIP-712 domain of every rail the marketplace accepts.
 *
 * These five facts used to live as literals in six places - the advertise path
 * (`router.ts`, `x402/payment-gate.ts`), the scheme registry
 * (`x402/server.ts`), the reconcile path (`x402/reconcile.ts`), the MPP server
 * and the signer (`agentic-wallet/constants.ts`, `agentic-wallet/sign.ts`) -
 * and the invariant that they agreed was maintained by a comment. KEEP-364 is
 * what that costs: the advertised `extra` and the signer's domain drifted, the
 * facilitator rejected every payment with "EIP-712 domain parameters (name,
 * version) are required", and the failure surfaced to all callers as
 * verification-failed.
 *
 * A rail is data here, so adding one is a row rather than an edit across six
 * files that must be kept consistent by review.
 *
 * Adds no rail and picks no facilitator: the multi-facilitator question and
 * the CDP-specific timeout behaviour in `reconcile.ts` stay on KEEP-1089.
 */

/** Payment protocols a rail can settle under. */
export type PaymentProtocol = "x402" | "mpp";

export interface PaymentRail {
  /** CAIP-2 network id, e.g. `eip155:8453`. */
  readonly network: `eip155:${number}`;
  readonly chainId: number;
  /** Settlement asset contract address, checksummed as the token reports it. */
  readonly asset: `0x${string}`;
  readonly assetDecimals: number;
  /**
   * EIP-712 domain fields of the settlement asset's
   * `TransferWithAuthorization`. `name` and `version` must be what the token
   * itself reports: `@x402/evm`'s `verifyEIP3009` reconstructs the domain from
   * them, so a value that merely looks right fails verification rather than
   * mismatching visibly.
   */
  readonly domain: { readonly name: string; readonly version: string };
  /** Protocols this rail is advertised and settled under. */
  readonly protocols: readonly PaymentProtocol[];
  /** Env var carrying the RPC URL used for on-chain reconcile reads. */
  readonly rpcUrlEnvVar: string;
  /** Public RPC used when the env var is unset. */
  readonly defaultRpcUrl: string;
}

export const BASE_RAIL: PaymentRail = {
  network: "eip155:8453",
  chainId: 8453,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  assetDecimals: 6,
  domain: { name: "USD Coin", version: "2" },
  protocols: ["x402"],
  rpcUrlEnvVar: "BASE_RPC_URL",
  defaultRpcUrl: "https://mainnet.base.org",
} as const;

export const TEMPO_RAIL: PaymentRail = {
  network: "eip155:4217",
  chainId: 4217,
  asset: "0x20c000000000000000000000b9537d11c60e8b50",
  assetDecimals: 6,
  domain: { name: "USD Coin", version: "2" },
  protocols: ["mpp"],
  rpcUrlEnvVar: "TEMPO_RPC_URL",
  defaultRpcUrl: "https://rpc.tempo.xyz",
} as const;

/**
 * Every rail, keyed by CAIP-2 network id.
 *
 * A rail that settles in something other than USDC needs no new shape here -
 * the asset, its decimals and its domain are already per-rail - which is the
 * case a third rail was expected to break. Robinhood Chain settles in USDG at
 * six decimals with EIP-3009 present, and would be one row.
 */
export const PAYMENT_RAILS: Readonly<Record<string, PaymentRail>> = {
  [BASE_RAIL.network]: BASE_RAIL,
  [TEMPO_RAIL.network]: TEMPO_RAIL,
} as const;

/** Rails advertised and settled under `protocol`. */
export function railsFor(protocol: PaymentProtocol): PaymentRail[] {
  return Object.values(PAYMENT_RAILS).filter((rail) =>
    rail.protocols.includes(protocol)
  );
}

/**
 * Select the single rail for `protocol` from `rails`.
 *
 * Separate from `railForProtocol` so the not-exactly-one branch can be
 * exercised: it is the interesting one, and it is unreachable through the
 * module-level table while each protocol has one rail.
 */
export function pickSingleRail(
  rails: readonly PaymentRail[],
  protocol: PaymentProtocol
): PaymentRail {
  const matches = rails.filter((rail) => rail.protocols.includes(protocol));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${protocol} rail, found ${matches.length}`
    );
  }
  return matches[0];
}

/**
 * The rail a protocol settles on. Each protocol currently has exactly one, and
 * this throws rather than guessing if that stops being true, so a second rail
 * on a protocol is a visible failure at startup instead of a silent choice of
 * whichever came first.
 */
export function railForProtocol(protocol: PaymentProtocol): PaymentRail {
  return pickSingleRail(Object.values(PAYMENT_RAILS), protocol);
}

/** Smallest-unit amount for a decimal price string on `rail`. */
export function toAssetUnits(rail: PaymentRail, price: string): number {
  return Math.round(Number(price) * 10 ** rail.assetDecimals);
}
