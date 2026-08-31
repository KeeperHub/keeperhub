import "server-only";

import { ethers } from "ethers";
import { safeFetch } from "@/lib/safe-fetch";
import { isNonRetryableError } from "@/lib/rpc/providers/error-classification";
import { rawToUi, UI_MULTIPLIER_UNIT } from "@/lib/web3/ui-multiplier";

/**
 * Shared logic for the Robinhood Chain stock-token read actions.
 *
 * These assets are tokenised equities, and almost everything awkward about them
 * comes from that: they carry two price conventions, their balances rescale
 * without a transfer, and they stop quoting when the underlying market closes.
 *
 * On price, this module deliberately does NOT reconcile the two sources into a
 * single number. The REST quote is the underlying equity's bid and ask; the
 * Chainlink feed is the token price with the multiplier already applied. The
 * documented conversion between them could not be verified: measured against
 * the live chain, staleness drift between the two sources (feeds legitimately
 * run hours old outside market hours, on an 86400 s heartbeat) is an order of
 * magnitude larger than the multipliers involved, and the one token where the
 * difference would be unmistakable, CRWD at 4.0, has no Chainlink feed at all.
 * Publishing a single "true" price computed from an unverified relationship is
 * how the balanceOf error happened. Both numbers are returned, each labelled
 * with its source and its age, and the caller decides.
 */

/** Robinhood Chain mainnet. The registry lists no testnet deployments. */
export const ROBINHOOD_CHAIN_ID = 4663;

const ASSETS_URL = "https://api.robinhood.com/rhj/assets";
const PRICES_URL = "https://api.robinhood.com/rhj/prices";
const FEEDS_URL =
  "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

/** The registry serves a 15 s cache of its own; this avoids hammering it. */
const REGISTRY_TTL_MS = 60_000;
/** Feed addresses change only when Chainlink deploys, which is rare. */
const FEEDS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export type StockToken = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /** Registry's view of the UI multiplier, as a decimal string. */
  currentMultiplier: string;
  /** Non-empty when a corporate action is scheduled but not yet effective. */
  pendingMultiplier: string;
  active: boolean;
};

export type StockQuote = {
  symbol: string;
  bid: string;
  ask: string;
  currency: string;
  isTradingHalt: boolean;
  /** When Robinhood produced this quote. */
  generatedAt: string;
  /** Null when the issuer sent no parseable timestamp, which blocks. */
  quoteAgeSeconds: number | null;
  dailyHigh?: string;
  dailyLow?: string;
  dailyTradingVolume?: string;
};

export type ChainlinkFeed = {
  address: string;
  /** Seconds Chainlink may go between updates without deviation. */
  heartbeatSeconds: number;
};

type Cached<T> = { value: T; fetchedAt: number };

let registryCache: Cached<Map<string, StockToken>> | null = null;
let feedsCache: Cached<Map<string, ChainlinkFeed>> | null = null;

/** Exposed for tests; not part of the runtime contract. */
export function __clearStockTokenCaches(): void {
  registryCache = null;
  feedsCache = null;
}

async function getJson(url: string): Promise<unknown> {
  const response = await safeFetch(url, {
    plugin: "robinhood",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return await response.json();
}

/**
 * Every active stock token on Robinhood Chain, keyed by ticker.
 *
 * The ticker is the key on purpose. A symbol search on the chain's explorer
 * returns many lookalike contracts, several with more holders than the real
 * one, so an address a user pasted is not self-validating. The issuer's own
 * registry is the only authority on which address is which equity.
 */
export async function loadStockTokens(): Promise<Map<string, StockToken>> {
  if (registryCache && Date.now() - registryCache.fetchedAt < REGISTRY_TTL_MS) {
    return registryCache.value;
  }

  const payload = (await getJson(ASSETS_URL)) as {
    assets?: Array<Record<string, unknown>>;
  };
  const tokens = new Map<string, StockToken>();

  for (const asset of payload.assets ?? []) {
    const deployments = (asset.deployments ?? []) as Array<
      Record<string, unknown>
    >;
    const deployment = deployments.find(
      (d) => Number(d.chainId) === ROBINHOOD_CHAIN_ID
    );
    if (!deployment) {
      continue;
    }
    const symbol = String(asset.tokenSymbol ?? "").toUpperCase();
    if (!symbol) {
      continue;
    }
    tokens.set(symbol, {
      symbol,
      name: String(asset.tokenName ?? symbol),
      address: String(deployment.contractAddress),
      decimals: Number(asset.tokenDecimals ?? 18),
      currentMultiplier: String(asset.currentMultiplier ?? "1"),
      pendingMultiplier: String(asset.pendingMultiplier ?? ""),
      active: asset.status === "ASSET_STATUS_ACTIVE",
    });
  }

  // An empty map means the payload shape changed, not that the chain has no
  // stock tokens. Caching it would answer "AAPL is not listed" confidently for
  // a full minute.
  if (tokens.size > 0) {
    registryCache = { value: tokens, fetchedAt: Date.now() };
  }
  return tokens;
}

/** Resolve a ticker to its token, or explain what is available. */
export async function resolveStockToken(
  symbol: string
): Promise<{ ok: true; token: StockToken } | { ok: false; error: string }> {
  const wanted = symbol.trim().toUpperCase();
  if (!wanted) {
    return { ok: false, error: "A ticker symbol is required, for example AAPL" };
  }

  let tokens: Map<string, StockToken>;
  try {
    tokens = await loadStockTokens();
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the Robinhood asset registry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const token = tokens.get(wanted);
  if (!token) {
    return {
      ok: false,
      error: `${wanted} is not a stock token on Robinhood Chain. ${tokens.size} tickers are listed.`,
    };
  }
  if (!token.active) {
    return { ok: false, error: `${wanted} is listed but not active.` };
  }
  return { ok: true, token };
}

/** The issuer's quote for the underlying equity. Not multiplier adjusted. */
export async function fetchQuote(symbol: string): Promise<StockQuote> {
  const payload = (await getJson(
    `${PRICES_URL}/${encodeURIComponent(symbol)}`
  )) as { quotes?: Array<Record<string, unknown>> };

  const quote = payload.quotes?.[0];
  if (!quote) {
    throw new Error(`No quote returned for ${symbol}`);
  }

  const generatedAt = String(quote.generatedAt ?? "");
  const generatedMs = Date.parse(generatedAt);
  return {
    symbol: String(quote.tokenSymbol ?? symbol),
    bid: String(quote.bid ?? ""),
    ask: String(quote.ask ?? ""),
    currency: String(quote.currency ?? "USD"),
    isTradingHalt: Boolean(quote.isTradingHalt),
    generatedAt,
    // Null rather than a sentinel. A -1 compares as fresher than any
    // threshold, so an unknown age would have read as an open market.
    quoteAgeSeconds: Number.isNaN(generatedMs)
      ? null
      : Math.max(0, Math.round((Date.now() - generatedMs) / 1000)),
    dailyHigh: quote.dailyHigh ? String(quote.dailyHigh) : undefined,
    dailyLow: quote.dailyLow ? String(quote.dailyLow) : undefined,
    dailyTradingVolume: quote.dailyTradingVolume
      ? String(quote.dailyTradingVolume)
      : undefined,
  };
}

/**
 * Chainlink's equity feeds on this chain, keyed by ticker.
 *
 * Addresses are read from Chainlink's published directory rather than
 * hardcoded, because the chain's own docs decline to publish them and point at
 * that directory as authoritative. Coverage is partial: 35 of the 194 listed
 * tokens have a feed, which is why the REST quote is the primary price and
 * this is corroboration.
 */
export async function loadChainlinkFeeds(): Promise<Map<string, ChainlinkFeed>> {
  if (feedsCache && Date.now() - feedsCache.fetchedAt < FEEDS_TTL_MS) {
    return feedsCache.value;
  }

  const payload = (await getJson(FEEDS_URL)) as Array<Record<string, unknown>>;
  const feeds = new Map<string, ChainlinkFeed>();

  for (const feed of payload) {
    const name = String(feed.name ?? "");
    if (!name.startsWith("Robinhood ")) {
      continue;
    }
    const symbol = name
      .replace("Robinhood ", "")
      .replace(" / USD", "")
      .replace("-USD", "")
      .trim()
      .toUpperCase();
    const address = String(feed.proxyAddress ?? "");
    if (!(symbol && address)) {
      continue;
    }
    const heartbeat = Number(feed.heartbeat);
    feeds.set(symbol, {
      address,
      // Zero when the directory gives nothing usable. Treated as unknown
      // rather than as "never stale" at the point of comparison.
      heartbeatSeconds: Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : 0,
    });
  }

  // Same reasoning as the registry, and worse here: an upstream rename would
  // silently disable every feed staleness check for an hour.
  if (feeds.size > 0) {
    feedsCache = { value: feeds, fetchedAt: Date.now() };
  }
  return feeds;
}

export type OnChainState = {
  uiMultiplier: string;
  /**
   * Fields that could not be read. A caller gating on this state must treat a
   * non-empty list as blocking: an unreadable pause flag is not an unset one.
   */
  unknown: string[];
  pendingMultiplier: string | null;
  /** Unix seconds a pending multiplier takes effect, when one is scheduled. */
  effectiveAt: number | null;
  paused: boolean;
  tokenPaused: boolean;
  oraclePaused: boolean;
};

const STOCK_ABI = [
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function tokenPaused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
] as const;

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
] as const;

/**
 * Read one value, separating "this contract does not implement it" from "we
 * could not tell".
 *
 * The distinction is the whole point. A missing function is a fact about the
 * token and it is safe to treat the value as absent. A timeout or a rate limit
 * is not a fact about anything, and collapsing the two lets a guard report
 * "nothing is wrong" when what it means is "I could not check".
 */
type ReadOutcome<T> =
  | { state: "ok"; value: T }
  | { state: "absent" }
  | { state: "unknown" };

async function tryRead<T>(read: () => Promise<T>): Promise<ReadOutcome<T>> {
  try {
    return { state: "ok", value: await read() };
  } catch (error) {
    return isNonRetryableError(error) ? { state: "absent" } : { state: "unknown" };
  }
}

/**
 * The token's own view of itself: how it scales, whether a rescale is
 * scheduled, and the three independent switches that can freeze it.
 *
 * Each field degrades to null or false independently. A token that predates
 * part of the interface still yields the fields it does implement, rather than
 * failing the whole read.
 */
export async function readOnChainState(
  provider: ethers.ContractRunner,
  tokenAddress: string
): Promise<OnChainState> {
  const contract = new ethers.Contract(tokenAddress, STOCK_ABI, provider);

  const [multiplier, pending, effective, paused, tokenPaused, oraclePaused] =
    await Promise.all([
      tryRead(() => contract.uiMultiplier() as Promise<bigint>),
      tryRead(() => contract.newUIMultiplier() as Promise<bigint>),
      tryRead(() => contract.effectiveAt() as Promise<bigint>),
      tryRead(() => contract.paused() as Promise<boolean>),
      tryRead(() => contract.tokenPaused() as Promise<boolean>),
      tryRead(() => contract.oraclePaused() as Promise<boolean>),
    ]);

  const unknown: string[] = [];
  const flag = (name: string, outcome: ReadOutcome<boolean>): boolean => {
    if (outcome.state === "unknown") {
      unknown.push(name);
      // Reported as unknown rather than false. The caller blocks on it.
      return false;
    }
    // An absent function means the token has no such switch, so it is not set.
    return outcome.state === "ok" ? outcome.value : false;
  };

  if (multiplier.state === "unknown") {
    unknown.push("uiMultiplier");
  }
  // These two decide whether a corporate action is pending. An unreadable one
  // leaves hasPending false below, which reads as "no action scheduled" rather
  // than "could not tell" - and a swap into a token about to rescale is the
  // exact case the pending check exists to stop.
  if (pending.state === "unknown") {
    unknown.push("newUIMultiplier");
  }
  if (effective.state === "unknown") {
    unknown.push("effectiveAt");
  }
  const scale =
    multiplier.state === "ok" && multiplier.value > BigInt(0)
      ? multiplier.value
      : UI_MULTIPLIER_UNIT;

  const effectiveAt = effective.state === "ok" ? Number(effective.value) : null;
  // A pending multiplier only means anything alongside a future effective
  // date; the fields hold their last values once an action has landed.
  const hasPending =
    pending.state === "ok" &&
    pending.value > BigInt(0) &&
    effectiveAt !== null &&
    effectiveAt * 1000 > Date.now();

  return {
    uiMultiplier: ethers.formatUnits(scale, 18),
    unknown,
    pendingMultiplier: hasPending ? ethers.formatUnits(pending.value, 18) : null,
    effectiveAt: hasPending ? effectiveAt : null,
    paused: flag("paused", paused),
    tokenPaused: flag("tokenPaused", tokenPaused),
    oraclePaused: flag("oraclePaused", oraclePaused),
  };
}

export type FeedReading = {
  address: string;
  price: string;
  updatedAt: string;
  ageSeconds: number;
  heartbeatSeconds: number;
  /** True past the feed's own heartbeat; null when no heartbeat is published. */
  beyondHeartbeat: boolean | null;
};

/**
 * Read a Chainlink equity feed, if this ticker has one.
 *
 * Staleness is judged against the feed's own heartbeat rather than a fixed
 * threshold. These feeds run on an 86400 s heartbeat and legitimately sit
 * hours old while the underlying market is closed, so any constant short
 * enough to be meaningful during a session would fire continuously overnight.
 */
export async function readChainlinkFeed(
  provider: ethers.ContractRunner,
  feed: ChainlinkFeed
): Promise<FeedReading | null> {
  const contract = new ethers.Contract(feed.address, CHAINLINK_ABI, provider);
  const outcome = await tryRead(
    () =>
      contract.latestRoundData() as Promise<
        [bigint, bigint, bigint, bigint, bigint]
      >
  );
  if (outcome.state !== "ok") {
    return null;
  }

  const [, answer, , updatedAt] = outcome.value;
  const updatedMs = Number(updatedAt) * 1000;
  const ageSeconds = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));

  return {
    address: feed.address,
    // Chainlink equity feeds on this chain report 8 decimals.
    price: ethers.formatUnits(answer, 8),
    updatedAt: new Date(updatedMs).toISOString(),
    ageSeconds,
    heartbeatSeconds: feed.heartbeatSeconds,
    // Null when there is no usable heartbeat to judge against. A caller must
    // treat null as unknown, not as fresh.
    beyondHeartbeat:
      feed.heartbeatSeconds > 0 ? ageSeconds > feed.heartbeatSeconds : null,
  };
}

/** A holder's position, in both conventions, with the factor between them. */
export async function readPosition(
  provider: ethers.ContractRunner,
  token: StockToken,
  holder: string
): Promise<{ raw: string; ui: string; uiMultiplier: string }> {
  const contract = new ethers.Contract(token.address, STOCK_ABI, provider);
  const [balanceRaw, multiplier] = await Promise.all([
    contract.balanceOf(holder) as Promise<bigint>,
    tryRead(() => contract.uiMultiplier() as Promise<bigint>),
  ]);

  // `shares` is the field this action tells callers to act on, so it must not
  // be quietly wrong. A multiplier we could not read would understate a CRWD
  // position fourfold while reporting a scale of 1.0, so it fails instead.
  // An absent function is different: the token genuinely does not scale.
  if (multiplier.state === "unknown") {
    throw new Error(
      `Could not read the UI multiplier for ${token.symbol}. Refusing to report a share count that may be understated.`
    );
  }
  if (multiplier.state === "ok" && multiplier.value <= BigInt(0)) {
    throw new Error(
      `${token.symbol} reported a zero UI multiplier, which cannot be right.`
    );
  }
  const effective =
    multiplier.state === "ok" ? multiplier.value : UI_MULTIPLIER_UNIT;

  return {
    raw: ethers.formatUnits(balanceRaw, token.decimals),
    ui: ethers.formatUnits(rawToUi(balanceRaw, effective), token.decimals),
    uiMultiplier: ethers.formatUnits(effective, 18),
  };
}
