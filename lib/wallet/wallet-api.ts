import type {
  ChainData,
  SupportedToken,
  TokenData,
  WalletData,
} from "@/lib/wallet/types";

export type SafeRow = {
  id: string;
  chainId: number;
  safeAddress: string;
  status: string;
  isSigningActive: boolean;
};

export type ChainsResult = {
  evmChains: ChainData[];
  /** True when the org has Solana enabled but only on a testnet cluster. */
  solanaIsTestnet: boolean;
};

export async function fetchWallet(): Promise<WalletData> {
  const response = await fetch("/api/user/wallet");
  return (await response.json()) as WalletData;
}

export async function fetchChains(): Promise<ChainsResult> {
  try {
    const response = await fetch("/api/chains");
    const data: ChainData[] = await response.json();
    const solanaChains = data.filter(
      (chain) => chain.chainType === "solana" && chain.isEnabled
    );
    return {
      evmChains: data.filter((chain) => chain.chainType === "evm"),
      solanaIsTestnet:
        solanaChains.length > 0 && !solanaChains.some((c) => !c.isTestnet),
    };
  } catch {
    return { evmChains: [], solanaIsTestnet: false };
  }
}

export async function fetchTrackedTokens(): Promise<TokenData[]> {
  try {
    const response = await fetch("/api/user/wallet/tokens");
    const data = await response.json();
    return data.tokens ?? [];
  } catch {
    return [];
  }
}

export async function fetchSupportedTokens(): Promise<SupportedToken[]> {
  try {
    const response = await fetch("/api/supported-tokens");
    const data = await response.json();
    return data.tokens ?? [];
  } catch {
    return [];
  }
}

export async function fetchDeployedSafes(): Promise<SafeRow[]> {
  try {
    const response = await fetch("/api/user/safe");
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { safes?: SafeRow[] };
    return (data.safes ?? []).filter((s) => s.status === "deployed");
  } catch {
    return [];
  }
}

export async function addTrackedToken(
  chainId: number,
  tokenAddress: string
): Promise<string> {
  const response = await fetch("/api/user/wallet/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainId, tokenAddress }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Failed to add token");
  }
  return data.token.symbol as string;
}

export async function removeTrackedToken(tokenId: string): Promise<void> {
  const response = await fetch("/api/user/wallet/tokens", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenId }),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error ?? "Failed to remove token");
  }
}

export async function createWallet(email: string): Promise<void> {
  const response = await fetch("/api/user/wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data: { error?: string } = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Failed to create wallet");
  }
}
