/**
 * Default tokens pre-selected per protocol when the policy wizard loads.
 *
 * Backed by a deterministic per-chain address book so seeding never depends
 * on the supported_tokens DB rows being populated -- defaults always show
 * up regardless of dev/staging seed state. Admins can remove or add tokens
 * before deploy via the wizard's X button or "+ Add token".
 *
 * Coverage targets the 4 chains we deploy Safes on today:
 *   Ethereum (1), Optimism (10), Base (8453), Arbitrum One (42161).
 *
 * If a default symbol isn't available on a given chain (e.g. AERO on
 * Ethereum) it just gets skipped -- no broken row.
 */

import type { ProtocolSlug } from "@/lib/safe/protocol-registry";

export type DefaultToken = {
  symbol: string;
  address: string;
  decimals: number;
};

const ETH = 1;
const OPT = 10;
const BASE = 8453;
const ARB = 42_161;

/**
 * Canonical token addresses per chain. Sourced from each chain's official
 * docs (Aave / Sky / Ethena / Lido / Rocket Pool / Aerodrome / Compound).
 * Decimals match the token contract's `decimals()`.
 */
const KNOWN_TOKENS_BY_CHAIN: Readonly<
  Record<number, Readonly<Record<string, DefaultToken>>>
> = {
  [ETH]: {
    USDC: {
      symbol: "USDC",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      decimals: 6,
    },
    DAI: {
      symbol: "DAI",
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      decimals: 18,
    },
    USDS: {
      symbol: "USDS",
      address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
      decimals: 18,
    },
    sDAI: {
      symbol: "sDAI",
      address: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      decimals: 18,
    },
    USDe: {
      symbol: "USDe",
      address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      decimals: 18,
    },
    sUSDe: {
      symbol: "sUSDe",
      address: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      decimals: 18,
    },
    WETH: {
      symbol: "WETH",
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      decimals: 8,
    },
    stETH: {
      symbol: "stETH",
      address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
      decimals: 18,
    },
    wstETH: {
      symbol: "wstETH",
      address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
      decimals: 18,
    },
    rETH: {
      symbol: "rETH",
      address: "0xae78736Cd615f374D3085123A210448E74Fc6393",
      decimals: 18,
    },
  },
  [OPT]: {
    USDC: {
      symbol: "USDC",
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      decimals: 6,
    },
    DAI: {
      symbol: "DAI",
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      decimals: 18,
    },
    WETH: {
      symbol: "WETH",
      address: "0x4200000000000000000000000000000000000006",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
      decimals: 8,
    },
    wstETH: {
      symbol: "wstETH",
      address: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb",
      decimals: 18,
    },
  },
  [BASE]: {
    USDC: {
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
    DAI: {
      symbol: "DAI",
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      decimals: 18,
    },
    WETH: {
      symbol: "WETH",
      address: "0x4200000000000000000000000000000000000006",
      decimals: 18,
    },
    cbBTC: {
      symbol: "cbBTC",
      address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      decimals: 8,
    },
    cbETH: {
      symbol: "cbETH",
      address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
      decimals: 18,
    },
    AERO: {
      symbol: "AERO",
      address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      decimals: 18,
    },
  },
  [ARB]: {
    USDC: {
      symbol: "USDC",
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
    },
    USDT: {
      symbol: "USDT",
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      decimals: 6,
    },
    DAI: {
      symbol: "DAI",
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      decimals: 18,
    },
    WETH: {
      symbol: "WETH",
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      decimals: 8,
    },
    wstETH: {
      symbol: "wstETH",
      address: "0x5979D7b546E38E414F7E9822514be443A4800529",
      decimals: 18,
    },
    rETH: {
      symbol: "rETH",
      address: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8",
      decimals: 18,
    },
  },
} as const;

const STABLES = ["USDC", "USDT", "DAI"] as const;
const STABLES_PLUS_ETH = [...STABLES, "WETH"] as const;

/**
 * Per-protocol preferred token symbols. Each is resolved against
 * `KNOWN_TOKENS_BY_CHAIN` for the active chain; missing combinations are
 * silently skipped so e.g. AERO does not show under Aave V3 on Ethereum.
 */
export const PROTOCOL_DEFAULT_TOKEN_SYMBOLS: Readonly<
  Record<ProtocolSlug, readonly string[]>
> = {
  "aave-v3": STABLES_PLUS_ETH,
  "aave-v4": ["wstETH", "WETH"],
  "compound-v3": ["USDC", "WETH", "WBTC"],
  cowswap: STABLES_PLUS_ETH,
  "uniswap-v3": STABLES_PLUS_ETH,
  curve: STABLES,
  lido: ["stETH", "wstETH"],
  "rocket-pool": ["rETH"],
  morpho: ["USDC", "WETH"],
  spark: ["DAI", "USDS", "sDAI", "WETH"],
  sky: ["DAI", "USDS"],
  ethena: ["USDe", "sUSDe"],
  "yearn-v3": ["USDC", "DAI", "WETH"],
  pendle: ["USDC", "WETH"],
  aerodrome: ["USDC", "WETH", "AERO"],
  ajna: ["USDC", "WETH"],
  chainlink: ["USDC", "WETH"],
  wrapped: ["WETH"],
} as const;

const STABLE_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "DAI",
  "USDS",
  "USDe",
  "sUSDe",
  "sDAI",
  "FRAX",
  "LUSD",
  "GUSD",
  "TUSD",
  "PYUSD",
]);

const ETH_LIKE_SYMBOLS = new Set([
  "WETH",
  "stETH",
  "wstETH",
  "rETH",
  "cbETH",
  "frxETH",
  "sfrxETH",
  "ETH",
]);

const BTC_LIKE_SYMBOLS = new Set(["WBTC", "tBTC", "cbBTC"]);

/**
 * Heuristic starting cap per token symbol. Chosen to land in a reasonable
 * order of magnitude so admins do not stare at "0" or have to do mental
 * math on first install -- they tweak from a sensible anchor.
 */
export function defaultAmountForSymbol(symbol: string): string {
  if (STABLE_SYMBOLS.has(symbol)) {
    return "1000";
  }
  if (ETH_LIKE_SYMBOLS.has(symbol)) {
    return "1";
  }
  if (BTC_LIKE_SYMBOLS.has(symbol)) {
    return "0.05";
  }
  return "100";
}

/**
 * Resolve a protocol's default token symbols against the chain address book.
 * Returns the matched tokens in the order declared in
 * `PROTOCOL_DEFAULT_TOKEN_SYMBOLS`. Symbols missing from the chain are
 * skipped silently.
 */
export function resolveDefaultTokensForProtocol(
  slug: ProtocolSlug,
  chainId: number
): DefaultToken[] {
  const wanted = PROTOCOL_DEFAULT_TOKEN_SYMBOLS[slug] ?? [];
  const chainTokens = KNOWN_TOKENS_BY_CHAIN[chainId] ?? {};
  const out: DefaultToken[] = [];
  for (const sym of wanted) {
    const match = chainTokens[sym];
    if (match) {
      out.push(match);
    }
  }
  return out;
}
