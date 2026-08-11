/**
 * Common token definitions per chain
 *
 * These are well-known tokens that can be used as defaults or for quick lookup.
 * Token addresses are checksummed.
 */

export type TokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  logoUrl?: string;
};

export type ChainTokens = {
  [chainId: number]: TokenInfo[];
};

/**
 * Well-known tokens per chain
 */
export const COMMON_TOKENS: ChainTokens = {
  // Ethereum Mainnet (chainId: 1)
  1: [
    {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
      name: "Tether USD",
    },
    {
      address: "0x6B175474E89094C44Da98b954EescdeCB5B9d15643d",
      symbol: "DAI",
      decimals: 18,
      name: "Dai Stablecoin",
    },
    {
      address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      symbol: "WBTC",
      decimals: 8,
      name: "Wrapped BTC",
    },
    {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      decimals: 18,
      name: "Wrapped Ether",
    },
    {
      address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      symbol: "LINK",
      decimals: 18,
      name: "Chainlink",
    },
    {
      address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      symbol: "UNI",
      decimals: 18,
      name: "Uniswap",
    },
  ],

  // Base Mainnet (chainId: 8453)
  8453: [
    {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
      name: "Wrapped Ether",
    },
    {
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      symbol: "DAI",
      decimals: 18,
      name: "Dai Stablecoin",
    },
  ],

  // Sepolia Testnet (chainId: 11155111)
  11155111: [
    {
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin (Circle testnet)",
    },
  ],

  // Optimism Sepolia (chainId: 11155420)
  11155420: [
    {
      address: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin (Circle testnet)",
    },
  ],

  // Base Sepolia (chainId: 84532)
  84532: [
    {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin (Circle testnet)",
    },
  ],

  // Arbitrum Sepolia (chainId: 421614)
  421614: [
    {
      address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin (Circle testnet)",
    },
  ],

  // Arbitrum One (chainId: 42161)
  42161: [
    {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      symbol: "USDT",
      decimals: 6,
      name: "Tether USD",
    },
    {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      symbol: "WETH",
      decimals: 18,
      name: "Wrapped Ether",
    },
    {
      address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      symbol: "WBTC",
      decimals: 8,
      name: "Wrapped BTC",
    },
  ],

  // Optimism (chainId: 10)
  10: [
    {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    {
      address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      symbol: "USDT",
      decimals: 6,
      name: "Tether USD",
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
      name: "Wrapped Ether",
    },
    {
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      symbol: "DAI",
      decimals: 18,
      name: "Dai Stablecoin",
    },
  ],

  // Polygon (chainId: 137)
  137: [
    {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    {
      address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      symbol: "USDT",
      decimals: 6,
      name: "Tether USD",
    },
    {
      address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      symbol: "WETH",
      decimals: 18,
      name: "Wrapped Ether",
    },
    {
      address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      symbol: "WMATIC",
      decimals: 18,
      name: "Wrapped Matic",
    },
  ],
};

/**
 * Get token info by chain and address
 */
export function getTokenInfo(
  chainId: number,
  address: string
): TokenInfo | undefined {
  const tokens = COMMON_TOKENS[chainId];
  if (!tokens) {
    return;
  }

  return tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/**
 * Get all tokens for a chain
 */
export function getChainTokens(chainId: number): TokenInfo[] {
  return COMMON_TOKENS[chainId] || [];
}

/**
 * Check if a token is a known stablecoin
 */
export function isStablecoin(symbol: string): boolean {
  const stablecoins = ["USDC", "USDT", "DAI", "BUSD", "TUSD", "FRAX", "LUSD"];
  return stablecoins.includes(symbol.toUpperCase());
}
