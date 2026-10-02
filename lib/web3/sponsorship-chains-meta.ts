export type SponsorshipChain = {
  chainId: number;
  name: string;
  isTestnet: boolean;
  /** Native gas-token ticker, for rendering gas amounts (ETH, POL, ...). */
  symbol: string;
};

// Chains where Turnkey's native Transaction Management (Gas Station) can sign
// and sponsor a transaction. This is the single source of truth shared by the
// runtime sponsorship preflight and the billing UI, so the two cannot drift.
// Turnkey supports four mainnets and their canonical testnets; Optimism and
// BNB are intentionally absent because the Gas Station does not cover them.
// `as const satisfies` rather than a `readonly SponsorshipChain[]` annotation:
// the literal chainId/isTestnet types survive, which lets chainlink-feeds.ts
// derive the set of billable chain ids as a type and require a price feed for
// each one at compile time.
export const SPONSORSHIP_CHAINS = [
  { chainId: 1, name: "Ethereum", isTestnet: false, symbol: "ETH" },
  { chainId: 137, name: "Polygon", isTestnet: false, symbol: "POL" },
  { chainId: 8453, name: "Base", isTestnet: false, symbol: "ETH" },
  { chainId: 42_161, name: "Arbitrum", isTestnet: false, symbol: "ETH" },
  {
    chainId: 11_155_111,
    name: "Ethereum Sepolia",
    isTestnet: true,
    symbol: "ETH",
  },
  { chainId: 80_002, name: "Polygon Amoy", isTestnet: true, symbol: "POL" },
  { chainId: 84_532, name: "Base Sepolia", isTestnet: true, symbol: "ETH" },
  {
    chainId: 421_614,
    name: "Arbitrum Sepolia",
    isTestnet: true,
    symbol: "ETH",
  },
] as const satisfies readonly SponsorshipChain[];

export const SPONSORSHIP_CHAIN_IDS: ReadonlySet<number> = new Set(
  SPONSORSHIP_CHAINS.map((c) => c.chainId)
);

/**
 * Whether Turnkey's Gas Station can sponsor a transaction on this chain.
 *
 * Lives here rather than in turnkey-sponsorship-config.ts so the node config
 * form can ask the same question the step does; that module is server-only
 * and re-exports this for the server-side callers.
 */
export function isSponsorshipSupported(chainId: number): boolean {
  return SPONSORSHIP_CHAIN_IDS.has(chainId);
}

export const SPONSORSHIP_MAINNET_NAMES: readonly string[] =
  SPONSORSHIP_CHAINS.filter((c) => !c.isTestnet).map((c) => c.name);

export const SPONSORSHIP_TESTNET_NAMES: readonly string[] =
  SPONSORSHIP_CHAINS.filter((c) => c.isTestnet).map((c) => c.name);
