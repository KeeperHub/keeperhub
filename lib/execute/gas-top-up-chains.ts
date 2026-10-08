/**
 * Chains where gas top-up runs: Turnkey sponsorship, the Uniswap V3 router and
 * quoter, and a WETH unwrap all exist there. Sepolia is for tests.
 */
export const GAS_TOP_UP_CHAIN_IDS = [1, 8453, 42_161, 11_155_111] as const;
export type GasTopUpChainId = (typeof GAS_TOP_UP_CHAIN_IDS)[number];

export function isGasTopUpChain(chainId: number): chainId is GasTopUpChainId {
  return (GAS_TOP_UP_CHAIN_IDS as readonly number[]).includes(chainId);
}
