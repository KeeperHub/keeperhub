import { ethers } from "ethers";
import { isNonRetryableError } from "@/lib/rpc/providers/error-classification";

/**
 * ERC-8056 UI multiplier handling.
 *
 * Robinhood Chain's stock tokens split a holding into two numbers. `balanceOf`
 * returns raw units; `balanceOfUI` returns `raw * uiMultiplier / 1e18`. A
 * corporate action such as a stock split changes the multiplier rather than
 * moving tokens, so the raw balance is untouched and the UI balance is what
 * changes. Robinhood's own app shows the UI number, and it is the share count.
 *
 * `transfer` and `transferFrom` take RAW units, and the standard has no
 * `transferUI`. So the display path and the mutation path speak different units
 * and nothing on-chain reconciles them. Ignoring the multiplier is wrong in both
 * directions at once: a balance reads low by the multiplier, and an amount typed
 * against the number the user was shown transfers high by it. On CRWD at 4.0
 * that is a 4x over-send.
 *
 * UI units are canonical: reads convert up, writes convert down.
 *
 * READS AND WRITES DO NOT SHARE A FAILURE MODE, and that distinction is the
 * whole safety argument of this module. If the multiplier cannot be read, a
 * balance that renders unscaled is a cosmetic degradation, while a transfer that
 * proceeds unscaled moves several times the intended amount. So the display
 * helper falls back and the write helper refuses. Use `resolveForDisplay` for
 * anything that renders and `resolveForWrite` for anything that signs.
 *
 * Because the write helper refuses, the probe is scoped to chains that can
 * actually host these tokens. Detecting by call alone would be more general,
 * but it would also make an extra `eth_call` a hard dependency of every ERC-20
 * transfer on every chain: a transient RPC failure would block a DAI transfer
 * on Ethereum, where an ERC-8056 token cannot exist. That trades a real bug on
 * one chain for an availability regression on all of them. The cost of the
 * probe belongs where the risk is.
 */

/** Fixed-point scale of `uiMultiplier()`, i.e. a multiplier of 1.0. */
export const UI_MULTIPLIER_UNIT = BigInt("1000000000000000000");

const ZERO = BigInt(0);

/**
 * Chains whose tokens may implement ERC-8056.
 *
 * Robinhood Chain and its testnet are the only deployments of the standard
 * today. Everywhere else this module is the identity and costs nothing: no
 * call, no cache entry, and no new way for a transfer to fail.
 *
 * Add a chain here when it gains scaled tokens. Until then, a token on an
 * unlisted chain is treated as unscaled without being asked, which is what it
 * is. Kept in code rather than on the chains table for the same reason
 * SPONSORSHIP_CHAINS and GAS_TOKEN_USD_FEEDS are: it is a property of the
 * standard's deployment, not of our configuration of the chain.
 */
const SCALED_TOKEN_CHAIN_IDS: ReadonlySet<number> = new Set([
  4663, // Robinhood Chain
  46_630, // Robinhood Chain Testnet
]);

/** Whether a token on this chain could carry a UI multiplier at all. */
export function chainMayScaleTokens(chainId: number): boolean {
  return SCALED_TOKEN_CHAIN_IDS.has(chainId);
}

const UI_MULTIPLIER_ABI = [
  "function uiMultiplier() view returns (uint256)",
] as const;

/**
 * How long a successfully read multiplier may be reused when rendering.
 *
 * Only the display path consults this. `updateMultiplier` is callable by the
 * issuer at will, so a write must never build a transaction on a cached value:
 * the cost of re-reading is one `eth_call` against the transaction it is about
 * to sign, which is negligible, and the cost of being wrong is the bug this
 * module exists to prevent.
 */
const DISPLAY_TTL_MS = 5 * 60 * 1000;

/**
 * Cap on distinct tokens remembered. The generic transfer node accepts any
 * address, so this map would otherwise grow without bound in a long-lived
 * process. Eviction is oldest-inserted-first, which is adequate: the entries
 * worth keeping are re-read and reinserted.
 */
const MAX_CACHE_ENTRIES = 5000;

type CacheEntry = {
  multiplier: bigint;
  /** null when the token provably has no such function, so it never expires. */
  fetchedAt: number | null;
};

const cache = new Map<string, CacheEntry>();
/** De-duplicates concurrent first reads of the same token. */
const inFlight = new Map<string, Promise<CacheEntry | null>>();

/** Exposed for tests; not part of the runtime contract. */
export function __clearUiMultiplierCache(): void {
  cache.clear();
  inFlight.clear();
}

function remember(key: string, entry: CacheEntry): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, entry);
}

/**
 * How to run one read against a provider.
 *
 * A function rather than the RpcManager itself, because the callers are split:
 * some hold an RpcManager, others are handed a provider already. Pass a runner
 * that fails over where one is available; the multiplier read should be no less
 * reliable than the balance read it accompanies.
 */
export type ProviderRunner = <T>(
  operation: (provider: ethers.ContractRunner) => Promise<T>
) => Promise<T>;

export type MultiplierResult =
  | { ok: true; multiplier: bigint }
  | { ok: false; error: unknown };

function cacheKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`;
}

/**
 * Read `uiMultiplier()` once and decide what the answer means.
 *
 * A non-retryable error (`CALL_EXCEPTION`, or a permanent `BAD_DATA`) means the
 * function is not there, which is every ordinary ERC-20. That verdict is cached
 * forever, because a contract cannot start implementing an interface at an
 * address it already occupies, and it is what keeps the steady-state cost of
 * this module at zero for non-Robinhood tokens.
 *
 * A transport failure -- timeout, rate limit, 5xx, dropped connection -- means
 * we do not know. It is deliberately NOT cached. Caching it would pin a scaled
 * token to unit for the lifetime of the process on the strength of one bad
 * second, silently restoring the over-send this module prevents.
 */
async function readMultiplier(
  run: ProviderRunner,
  key: string,
  tokenAddress: string
): Promise<CacheEntry | null> {
  try {
    const value = await run((provider) => {
      const contract = new ethers.Contract(
        tokenAddress,
        UI_MULTIPLIER_ABI,
        provider
      );
      return contract.uiMultiplier() as Promise<bigint>;
    });

    // A zero or negative multiplier would zero every balance and make the
    // write conversion divide by zero. No legitimate deployment reports it;
    // treat it as "not an ERC-8056 token" rather than trusting it.
    const entry: CacheEntry =
      value > ZERO
        ? { multiplier: value, fetchedAt: Date.now() }
        : { multiplier: UI_MULTIPLIER_UNIT, fetchedAt: null };
    remember(key, entry);
    return entry;
  } catch (error) {
    if (isNonRetryableError(error)) {
      const entry: CacheEntry = {
        multiplier: UI_MULTIPLIER_UNIT,
        fetchedAt: null,
      };
      remember(key, entry);
      return entry;
    }
    return null;
  }
}

function readMultiplierDeduped(
  run: ProviderRunner,
  key: string,
  tokenAddress: string
): Promise<CacheEntry | null> {
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }
  const promise = readMultiplier(run, key, tokenAddress).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/**
 * The multiplier to render a balance or allowance with.
 *
 * Never throws and never fails. When the multiplier cannot be read, a
 * previously known value is preferred over unit, because a stale scaled value
 * is closer to the truth than an unscaled one; unit is the last resort.
 */
export async function resolveForDisplay(
  run: ProviderRunner,
  chainId: number,
  tokenAddress: string
): Promise<bigint> {
  if (!chainMayScaleTokens(chainId)) {
    return UI_MULTIPLIER_UNIT;
  }

  const key = cacheKey(chainId, tokenAddress);
  const cached = cache.get(key);
  if (
    cached &&
    (cached.fetchedAt === null ||
      Date.now() - cached.fetchedAt < DISPLAY_TTL_MS)
  ) {
    return cached.multiplier;
  }

  const entry = await readMultiplierDeduped(run, key, tokenAddress);
  if (entry) {
    return entry.multiplier;
  }
  // Refresh failed. Keep whatever we last knew rather than downgrading a token
  // we have already established is scaled.
  return cached?.multiplier ?? UI_MULTIPLIER_UNIT;
}

/**
 * The multiplier to build a transaction with.
 *
 * Reports failure instead of guessing. The only cached answer it will accept is
 * the permanent "this token has no such function" verdict; a positive value is
 * always re-read, because the issuer can change it between the read and the
 * signature.
 */
export async function resolveForWrite(
  run: ProviderRunner,
  chainId: number,
  tokenAddress: string
): Promise<MultiplierResult> {
  if (!chainMayScaleTokens(chainId)) {
    return { ok: true, multiplier: UI_MULTIPLIER_UNIT };
  }

  const key = cacheKey(chainId, tokenAddress);
  const cached = cache.get(key);
  if (cached?.fetchedAt === null) {
    return { ok: true, multiplier: cached.multiplier };
  }

  const entry = await readMultiplierDeduped(run, key, tokenAddress);
  if (entry) {
    return { ok: true, multiplier: entry.multiplier };
  }
  return {
    ok: false,
    error: new Error(
      `Could not read the UI multiplier for ${tokenAddress} on chain ${chainId}. ` +
        "Refusing to build a transfer that could move the wrong amount."
    ),
  };
}

/** Raw on-chain units to the UI units a holder is shown. */
export function rawToUi(raw: bigint, multiplier: bigint): bigint {
  if (multiplier === UI_MULTIPLIER_UNIT) {
    return raw;
  }
  return (raw * multiplier) / UI_MULTIPLIER_UNIT;
}

/**
 * UI units a user typed to the raw units `transfer` expects.
 *
 * Floors. The division is rarely exact once a multiplier drifts off 1.0 through
 * dividend accrual, and rounding up would move more of the asset than the user
 * asked for. Erring low costs a rounding unit of dust; erring high spends their
 * money.
 */
export function uiToRaw(ui: bigint, multiplier: bigint): bigint {
  if (multiplier === UI_MULTIPLIER_UNIT) {
    return ui;
  }
  return (ui * UI_MULTIPLIER_UNIT) / multiplier;
}

export type AmountConversion =
  | { ok: true; raw: bigint }
  | { ok: false; error: string };

/**
 * Convert a typed amount for a transfer or an approval.
 *
 * Rejects a non-zero request that floors to zero. `transfer(to, 0)` succeeds
 * on-chain and moves nothing, and `approve(spender, 0)` is a revocation, so
 * executing either while reporting the amount the user asked for would be a
 * silent no-op or a silent revocation.
 */
export function convertAmountForWrite(
  ui: bigint,
  multiplier: bigint
): AmountConversion {
  const raw = uiToRaw(ui, multiplier);
  if (raw === ZERO && ui > ZERO) {
    return {
      ok: false,
      error:
        "Amount is too small for this token: it rounds to zero once converted " +
        "to on-chain units. Use a larger amount.",
    };
  }
  return { ok: true, raw };
}

/** True when this token scales, i.e. the conversions are not the identity. */
export function isScaledToken(multiplier: bigint): boolean {
  return multiplier !== UI_MULTIPLIER_UNIT;
}
