/**
 * Chains whose token lineup does not mirror Ethereum mainnet's stablecoin set
 * (Plasma ships USDT0 with no Circle USDC and no Sky USDS; HyperEVM has USDC
 * and USDT0 but no USDS; Unichain has no code at Ethereum's USDT address and
 * ships USD₮0 at a different one; Tempo and Arc pay gas in stablecoins). For these chains the
 * wallet renders the chain's own supported_tokens rows directly instead of
 * overlaying them on the mainnet master list, which would otherwise produce
 * misleading "Not available" entries for assets that do not exist there.
 *
 * This list previously existed twice, once in the wallet overlay and once in
 * the supported-tokens route, kept in step by hand. Adding a chain to one and
 * not the other is silent: the API returns the chain's own rows while the
 * overlay renders the mainnet list against them, or the reverse. One copy,
 * imported by both, is why this module exists.
 *
 * Kept free of ethers, React and any server-only import so both sides can
 * import it.
 */
export const INDEPENDENT_TOKEN_LIST_CHAIN_IDS: readonly number[] = [
  42_431, // Tempo Testnet
  4217, // Tempo
  9745, // Plasma
  999, // HyperEVM
  5042, // Arc (USDC is the native gas token)
  5_042_002, // Arc Testnet
  130, // Unichain
];

export function hasIndependentTokenList(chainId: number): boolean {
  return INDEPENDENT_TOKEN_LIST_CHAIN_IDS.includes(chainId);
}
