// Minimal EIP-1193 / EIP-6963 typings for injected browser wallets. We only
// touch the request method and the discovery event shape, so this avoids
// pulling a connector library just for types.

export type Eip1193RequestArgs = {
  method: string;
  params?: unknown[] | Record<string, unknown>;
};

export type Eip1193Provider = {
  request: <T = unknown>(args: Eip1193RequestArgs) => Promise<T>;
};

// EIP-6963: a wallet announces itself with this info + its provider.
export type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type DiscoveredWallet = {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
};

// A known wallet shown in the "install" list when not already detected.
// `rdns` matches the EIP-6963 id a wallet announces with, so we can hide an
// entry once that wallet is installed.
export type WalletBrand = {
  rdns: string;
  name: string;
  installUrl: string;
  // Path to the wallet's official brand icon under /public/wallets.
  icon: string;
};

// Common shape both detected and install-list wallets render through.
export type WalletRowData = {
  key: string;
  name: string;
  icon: string;
};
